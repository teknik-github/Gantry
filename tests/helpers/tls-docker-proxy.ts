import { execFileSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { Duplex } from "node:stream"

/**
 * Test harness for Docker over mutual TLS (`dockerd --tlsverify`) without
 * reconfiguring the real daemon: throwaway certificates generated with
 * openssl, and an https server that requires a client certificate and
 * forwards every request (including the HTTP Upgrade used by exec) to the
 * local Docker socket.
 */

export type TlsFixtures = {
  dir: string
  /** CA that signed the server and client certificates. */
  ca: string
  server: { cert: string; key: string }
  client: { cert: string; key: string }
  /** An unrelated CA and a client certificate it signed (must be rejected). */
  rogueCa: string
  rogueClient: { cert: string; key: string }
  cleanup(): void
}

function openssl(dir: string, args: string[]) {
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" })
}

function makeCa(dir: string, name: string) {
  openssl(dir, [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", `${name}-key.pem`, "-out", `${name}.pem`, "-days", "2", "-subj", `/CN=gantry-test-b ${name}`,
  ])
}

function makeCert(dir: string, ca: string, name: string, cn: string, ext: string) {
  fs.writeFileSync(path.join(dir, `${name}.ext`), ext)
  openssl(dir, [
    "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", `${name}-key.pem`, "-out", `${name}.csr`, "-subj", `/CN=${cn}`,
  ])
  openssl(dir, [
    "x509", "-req", "-in", `${name}.csr`, "-CA", `${ca}.pem`, "-CAkey", `${ca}-key.pem`, "-CAcreateserial",
    "-out", `${name}.pem`, "-days", "2", "-extfile", `${name}.ext`,
  ])
  return {
    cert: fs.readFileSync(path.join(dir, `${name}.pem`), "utf8"),
    key: fs.readFileSync(path.join(dir, `${name}-key.pem`), "utf8"),
  }
}

/** Generates a CA, a server cert for 127.0.0.1/localhost and client certs into a temp dir. */
export function generateTlsFixtures(): TlsFixtures {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-test-b-tls-"))
  makeCa(dir, "ca")
  makeCa(dir, "rogue-ca")
  const server = makeCert(
    dir,
    "ca",
    "server",
    "127.0.0.1",
    "subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n"
  )
  const client = makeCert(dir, "ca", "client", "gantry-client", "extendedKeyUsage=clientAuth\n")
  const rogueClient = makeCert(dir, "rogue-ca", "rogue-client", "gantry-client", "extendedKeyUsage=clientAuth\n")
  return {
    dir,
    ca: fs.readFileSync(path.join(dir, "ca.pem"), "utf8"),
    server,
    client,
    rogueCa: fs.readFileSync(path.join(dir, "rogue-ca.pem"), "utf8"),
    rogueClient,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

export type TlsDockerProxy = {
  port: number
  /** "127.0.0.1:<port>", as entered for a TCP environment. */
  address: string
  close(): Promise<void>
}

/**
 * Starts an https server on 127.0.0.1 (ephemeral port) that only accepts
 * clients presenting a certificate signed by `ca`, and proxies to Docker.
 */
export function startTlsDockerProxy(opts: {
  ca: string
  cert: string
  key: string
  socketPath?: string
}): Promise<TlsDockerProxy> {
  const socketPath = opts.socketPath ?? process.env.DOCKER_SOCKET ?? "/var/run/docker.sock"
  const hijacked = new Set<Duplex>()

  const server = https.createServer(
    { ca: opts.ca, cert: opts.cert, key: opts.key, requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      const upstream = http.request(
        { socketPath, method: req.method, path: req.url, headers: req.headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers)
          up.pipe(res)
        }
      )
      upstream.on("error", (err) => {
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" })
        res.end(`proxy error: ${err.message}`)
      })
      req.pipe(upstream)
    }
  )

  // Docker's hijacked exec: replay the request on the socket, then splice raw bytes.
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const upstream = net.connect(socketPath, () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
      upstream.write(raw + "\r\n")
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    hijacked.add(socket).add(upstream)
    const done = () => {
      socket.destroy()
      upstream.destroy()
      hijacked.delete(socket)
      hijacked.delete(upstream)
    }
    socket.on("error", done).on("close", done)
    upstream.on("error", done).on("close", done)
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo
      resolve({
        port,
        address: `127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            for (const s of hijacked) s.destroy()
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}
