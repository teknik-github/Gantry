import "server-only"

import crypto from "node:crypto"

/**
 * The parts of WebSocket (RFC 6455) and of Kubernetes' channel protocol
 * that `kubectl exec` needs, kept dependency-free and pure so they can be
 * unit tested: frame encoding (clients always mask), an incremental frame
 * parser with fragmentation and control frames, and the channel framing
 * (first payload byte = stream: 0 stdin, 1 stdout, 2 stderr, 3 status,
 * 4 resize; v5 adds 255 = close a stream).
 */

export const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const

/** Subprotocols offered for exec, best first. */
export const EXEC_PROTOCOLS = ["v5.channel.k8s.io", "v4.channel.k8s.io"] as const

export const CHANNEL = { stdin: 0, stdout: 1, stderr: 2, status: 3, resize: 4, close: 255 } as const

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
/** Exec output arrives in small frames; anything this big is not a terminal. */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

export function websocketKey(): string {
  return crypto.randomBytes(16).toString("base64")
}

/** The Sec-WebSocket-Accept value a server must answer for `key`. */
export function acceptFor(key: string): string {
  return crypto.createHash("sha1").update(key + GUID).digest("base64")
}

/** One frame (always FIN). Pass a 4-byte `mask` for client frames; omit it for server frames (tests). */
export function encodeFrame(opcode: number, payload: Buffer, mask?: Buffer): Buffer {
  const len = payload.length
  const header: number[] = [0x80 | opcode]
  const maskBit = mask ? 0x80 : 0
  if (len < 126) header.push(maskBit | len)
  else if (len < 65536) header.push(maskBit | 126, len >> 8, len & 0xff)
  else {
    header.push(maskBit | 127)
    const big = Buffer.alloc(8)
    big.writeBigUInt64BE(BigInt(len))
    header.push(...big)
  }
  if (!mask) return Buffer.concat([Buffer.from(header), payload])
  const body = Buffer.alloc(len)
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([Buffer.from(header), mask, body])
}

/** A client frame with a fresh random mask. */
export function clientFrame(opcode: number, payload: Buffer): Buffer {
  return encodeFrame(opcode, payload, crypto.randomBytes(4))
}

export class WebSocketProtocolError extends Error {}

export type WsMessage = { opcode: number; payload: Buffer }

/**
 * Incremental parser: feed it socket chunks, get whole messages (data
 * messages reassembled from fragments; control frames passed through as
 * they arrive, even between fragments).
 */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private fragmentOpcode: number | null = null
  private fragmentBytes = 0

  constructor(private onMessage: (message: WsMessage) => void) {}

  push(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    for (;;) {
      const frame = this.next()
      if (!frame) return
      this.handle(frame)
    }
  }

  private next(): { fin: boolean; opcode: number; payload: Buffer } | null {
    const buf = this.buffer
    if (buf.length < 2) return null
    const fin = (buf[0] & 0x80) !== 0
    if (buf[0] & 0x70) throw new WebSocketProtocolError("Unexpected reserved bits (no extensions were negotiated)")
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let len = buf[1] & 0x7f
    let offset = 2
    if (len === 126) {
      if (buf.length < 4) return null
      len = buf.readUInt16BE(2)
      offset = 4
    } else if (len === 127) {
      if (buf.length < 10) return null
      const big = buf.readBigUInt64BE(2)
      if (big > BigInt(MAX_MESSAGE_BYTES)) throw new WebSocketProtocolError("Frame too large")
      len = Number(big)
      offset = 10
    }
    if (len > MAX_MESSAGE_BYTES) throw new WebSocketProtocolError("Frame too large")
    const maskOffset = offset
    if (masked) offset += 4
    if (buf.length < offset + len) return null

    let payload = buf.subarray(offset, offset + len)
    if (masked) {
      const mask = buf.subarray(maskOffset, maskOffset + 4)
      payload = Buffer.from(payload)
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
    }
    this.buffer = buf.subarray(offset + len)
    return { fin, opcode, payload }
  }

  private handle({ fin, opcode, payload }: { fin: boolean; opcode: number; payload: Buffer }) {
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) throw new WebSocketProtocolError("Invalid control frame")
      this.onMessage({ opcode, payload: Buffer.from(payload) })
      return
    }
    if (opcode === OPCODE.continuation) {
      if (this.fragmentOpcode === null) throw new WebSocketProtocolError("Continuation without a message")
    } else {
      if (this.fragmentOpcode !== null) throw new WebSocketProtocolError("New message inside a fragmented one")
      if (fin) {
        this.onMessage({ opcode, payload: Buffer.from(payload) })
        return
      }
      this.fragmentOpcode = opcode
    }
    this.fragmentBytes += payload.length
    if (this.fragmentBytes > MAX_MESSAGE_BYTES) throw new WebSocketProtocolError("Message too large")
    this.fragments.push(Buffer.from(payload))
    if (fin) {
      const message = { opcode: this.fragmentOpcode!, payload: Buffer.concat(this.fragments) }
      this.fragments = []
      this.fragmentOpcode = null
      this.fragmentBytes = 0
      this.onMessage(message)
    }
  }
}

/** A message for one exec stream: the channel byte, then the data. */
export function channelMessage(channel: number, data: Buffer | string): Buffer {
  const body = typeof data === "string" ? Buffer.from(data, "utf8") : data
  return Buffer.concat([Buffer.from([channel]), body])
}

/** Terminal size for the resize channel. */
export function resizeMessage(cols: number, rows: number): Buffer {
  return channelMessage(CHANNEL.resize, JSON.stringify({ Width: cols, Height: rows }))
}

export function parseChannelMessage(payload: Buffer): { channel: number; data: Buffer } | null {
  if (payload.length === 0) return null
  return { channel: payload[0], data: payload.subarray(1) }
}

/**
 * The exit code in the Status sent on the status channel when the command
 * ends: 0 for Success, the ExitCode cause for NonZeroExitCode, else null.
 */
export function exitCodeFromStatus(data: Buffer | string): { exitCode: number | null; message?: string } {
  let status: { status?: string; reason?: string; message?: string; details?: { causes?: { reason?: string; message?: string }[] } }
  try {
    status = JSON.parse(data.toString())
  } catch {
    return { exitCode: null }
  }
  if (status.status === "Success") return { exitCode: 0 }
  const cause = status.details?.causes?.find((c) => c.reason === "ExitCode")
  const code = cause ? Number(cause.message) : NaN
  if (Number.isInteger(code)) return { exitCode: code }
  return { exitCode: null, message: status.message }
}
