import "server-only"

import https from "node:https"
import type { Duplex } from "node:stream"

import { assertCapacity, registerSession } from "@/lib/server/exec-sessions"
import { buildRequest, connectionError, errorFromResponse, KubeError, type KubeTarget } from "@/lib/server/kubernetes/client"
import {
  acceptFor,
  CHANNEL,
  channelMessage,
  clientFrame,
  EXEC_PROTOCOLS,
  exitCodeFromStatus,
  FrameParser,
  OPCODE,
  parseChannelMessage,
  resizeMessage,
  websocketKey,
  type WsMessage,
} from "@/lib/server/kubernetes/ws"

/**
 * `kubectl exec` from the server: a WebSocket to the pod's exec endpoint
 * (v5.channel.k8s.io, falling back to v4) over the same TLS settings and
 * credentials as every other API call, registered as a console session so
 * the browser uses the same /api/exec/:sid routes as Docker consoles.
 */

const CONNECT_TIMEOUT_MS = 15_000

/** Upgrades a GET to a WebSocket. Resolves with the socket and the subprotocol the server picked. */
export function connectWebSocket(
  target: KubeTarget,
  req: { path: string; query?: Record<string, string | number | boolean | readonly string[] | undefined> },
  protocols: readonly string[]
): Promise<{ socket: Duplex; protocol: string; head: Buffer }> {
  let options: https.RequestOptions
  try {
    options = buildRequest(target, { method: "GET", path: req.path, query: req.query, timeoutMs: CONNECT_TIMEOUT_MS }).options
  } catch (err) {
    return Promise.reject(err)
  }
  const key = websocketKey()
  options.headers = {
    ...options.headers,
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": key,
    "Sec-WebSocket-Protocol": protocols.join(", "),
  }

  return new Promise((resolve, reject) => {
    const request = https.request(options)
    request.on("upgrade", (res, socket, head) => {
      const protocol = String(res.headers["sec-websocket-protocol"] ?? "")
      if (res.headers["sec-websocket-accept"] !== acceptFor(key)) {
        socket.destroy()
        return reject(new KubeError("The Kubernetes API answered the WebSocket handshake incorrectly", 502))
      }
      if (!protocols.includes(protocol)) {
        socket.destroy()
        return reject(new KubeError(`The Kubernetes API doesn't support exec over WebSocket (${protocol || "no subprotocol"})`, 502))
      }
      socket.setTimeout(0)
      socket.setKeepAlive(true, 30_000)
      resolve({ socket, protocol, head })
    })
    // Anything but 101 Switching Protocols is an error (forbidden, pod or container not found, ...).
    request.on("response", (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.length < 64 && chunks.push(c))
      res.on("end", () => reject(errorFromResponse(res.statusCode ?? 502, Buffer.concat(chunks).toString("utf8"))))
    })
    request.on("timeout", () => request.destroy(new KubeError("The Kubernetes API did not start the exec in time", 504)))
    request.on("error", (err: NodeJS.ErrnoException) => reject(connectionError(err)))
    request.end()
  })
}

/** Minimal client WebSocket on an upgraded socket: binary messages out, messages in, ping/pong and close handled. */
export class ClientWebSocket {
  private closed = false

  constructor(
    private socket: Duplex,
    head: Buffer,
    handlers: { onMessage: (message: WsMessage) => void; onClose: () => void }
  ) {
    const parser = new FrameParser((message) => {
      if (message.opcode === OPCODE.ping) this.raw(OPCODE.pong, message.payload)
      else if (message.opcode === OPCODE.close) this.close()
      else if (message.opcode === OPCODE.binary || message.opcode === OPCODE.text) handlers.onMessage(message)
    })
    const end = () => {
      this.closed = true
      handlers.onClose()
    }
    socket.on("data", (chunk: Buffer) => {
      try {
        parser.push(chunk)
      } catch {
        socket.destroy()
      }
    })
    socket.on("close", end)
    socket.on("error", () => socket.destroy())
    if (head.length) socket.emit("data", head)
  }

  private raw(opcode: number, payload: Buffer) {
    if (this.closed || this.socket.destroyed) return
    this.socket.write(clientFrame(opcode, payload))
  }

  send(payload: Buffer) {
    this.raw(OPCODE.binary, payload)
  }

  /** Normal closure, then drop the connection. */
  close() {
    if (this.closed) return
    const code = Buffer.alloc(2)
    code.writeUInt16BE(1000)
    this.raw(OPCODE.close, code)
    this.closed = true
    this.socket.end()
    setTimeout(() => this.socket.destroy(), 1_000).unref()
  }
}

export const POD_SHELLS = {
  // Prefer bash when the image has it, otherwise plain sh.
  auto: ["/bin/sh", "-c", "export TERM=xterm-256color; if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi"],
  bash: ["/bin/bash"],
  sh: ["/bin/sh"],
} as const

export type PodShell = keyof typeof POD_SHELLS

/** The exec request for a container: command repeated per argument, TTY with stdin. */
export function execRequest(namespace: string, pod: string, container: string, command: readonly string[]) {
  return {
    path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/exec`,
    // With a TTY, stderr is merged into stdout.
    query: { container, command, stdin: true, stdout: true, stderr: false, tty: true },
  }
}

/** Opens an interactive shell in a pod's container; returns the console session id. */
export async function openPodExecSession(opts: {
  userId: number
  /** Environment the console runs in (access is re-checked against it). */
  environmentId: number
  target: KubeTarget
  namespace: string
  pod: string
  container: string
  command: readonly string[]
  cols: number
  rows: number
}): Promise<string> {
  assertCapacity(opts.userId)
  const { socket, head } = await connectWebSocket(
    opts.target,
    execRequest(opts.namespace, opts.pod, opts.container, opts.command),
    EXEC_PROTOCOLS
  )

  return registerSession(opts.userId, opts.environmentId, (sink) => {
    let exit: number | null = null
    const ws = new ClientWebSocket(socket, head, {
      onMessage({ payload }) {
        const msg = parseChannelMessage(payload)
        if (!msg) return
        if (msg.channel === CHANNEL.stdout || msg.channel === CHANNEL.stderr) sink.data(msg.data)
        else if (msg.channel === CHANNEL.status) {
          const status = exitCodeFromStatus(msg.data)
          exit = status.exitCode
          if (status.exitCode === null && status.message) sink.data(Buffer.from(`\r\n${status.message}\r\n`))
        }
      },
      onClose: () => sink.closed(),
    })
    ws.send(resizeMessage(opts.cols, opts.rows))
    return {
      write: (data) => ws.send(channelMessage(CHANNEL.stdin, data)),
      async resize(cols, rows) {
        ws.send(resizeMessage(cols, rows))
      },
      destroy: () => ws.close(),
      exitCode: async () => exit,
    }
  })
}
