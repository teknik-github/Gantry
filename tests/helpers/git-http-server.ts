import { execFile, spawn } from "node:child_process"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

// A local Git server for tests: bare repositories served over smart HTTP by
// `git http-backend` (CGI) behind a tiny node server, optionally requiring
// HTTP Basic auth. No internet, no Gitea. Loopback http only, which Gantry
// accepts when GANTRY_TEST_ALLOW_HTTP_GIT=1.

const run = promisify(execFile)

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Gantry Test",
  GIT_AUTHOR_EMAIL: "test@gantry.invalid",
  GIT_COMMITTER_NAME: "Gantry Test",
  GIT_COMMITTER_EMAIL: "test@gantry.invalid",
}

export type GitServer = {
  port: number
  /** Directory holding the bare repositories (<name>.git). */
  root: string
  url: (repo: string) => string
  /** Request paths (with query) seen, for asserting nothing secret is in URLs. */
  requests: string[]
  /** Authorization header values that were accepted or rejected. */
  authHeaders: string[]
  close: () => Promise<void>
}

export async function startGitServer(opts: { auth?: { username: string; password: string } } = {}): Promise<GitServer> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gantry-test-git-"))
  const requests: string[] = []
  const authHeaders: string[] = []
  const expected = opts.auth ? `Basic ${Buffer.from(`${opts.auth.username}:${opts.auth.password}`).toString("base64")}` : null

  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "")
    const auth = req.headers.authorization
    if (auth) authHeaders.push(auth)
    if (expected && auth !== expected) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="gantry-test"' }).end("Unauthorized")
      return
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.replace(/^\?/, ""),
      REQUEST_METHOD: req.method ?? "GET",
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      REMOTE_ADDR: "127.0.0.1",
    }
    if (req.headers["content-length"]) env.CONTENT_LENGTH = String(req.headers["content-length"])
    if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = String(req.headers["content-encoding"])
    if (req.headers["git-protocol"]) env.GIT_PROTOCOL = String(req.headers["git-protocol"])
    if (opts.auth) env.REMOTE_USER = opts.auth.username

    const cgi = spawn("git", ["http-backend"], { env: env as unknown as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "inherit"] })
    req.pipe(cgi.stdin)
    let head = Buffer.alloc(0)
    let headersDone = false
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (headersDone) {
        res.write(chunk)
        return
      }
      head = Buffer.concat([head, chunk])
      const sep = head.indexOf("\r\n\r\n") >= 0 ? head.indexOf("\r\n\r\n") : head.indexOf("\n\n")
      if (sep < 0) return
      const sepLen = head[sep] === 13 ? 4 : 2
      const lines = head.subarray(0, sep).toString("utf8").split(/\r?\n/)
      let status = 200
      const headers: Record<string, string> = {}
      for (const line of lines) {
        const i = line.indexOf(":")
        if (i < 0) continue
        const k = line.slice(0, i).trim()
        const v = line.slice(i + 1).trim()
        if (k.toLowerCase() === "status") status = Number.parseInt(v, 10)
        else headers[k] = v
      }
      res.writeHead(status, headers)
      headersDone = true
      const rest = head.subarray(sep + sepLen)
      if (rest.length) res.write(rest)
    })
    cgi.on("close", () => {
      if (!headersDone) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port

  return {
    port,
    root,
    url: (repo) => `http://127.0.0.1:${port}/${repo}.git`,
    requests,
    authHeaders,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections?.()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

/** A bare repository `<name>.git` under the server root plus a work tree to commit from. */
export async function createRepo(server: GitServer, name: string) {
  const bare = path.join(server.root, `${name}.git`)
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "gantry-test-work-"))
  await run("git", ["init", "--quiet", "--bare", "--initial-branch=main", bare], { env: GIT_ENV })
  await run("git", ["init", "--quiet", "--initial-branch=main", work], { env: GIT_ENV })
  return {
    bare,
    work,
    /** Writes files, commits them and pushes to `branch`; returns the commit id. */
    async commit(files: Record<string, string>, message: string, branch = "main") {
      for (const [file, text] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(work, file)), { recursive: true })
        await fs.writeFile(path.join(work, file), text)
      }
      await run("git", ["add", "-A"], { cwd: work, env: GIT_ENV })
      await run("git", ["commit", "--quiet", "--allow-empty", "-m", message], { cwd: work, env: GIT_ENV })
      await run("git", ["push", "--quiet", "--force", bare, `HEAD:refs/heads/${branch}`], { cwd: work, env: GIT_ENV })
      const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: work, env: GIT_ENV })
      return stdout.trim()
    },
    async remove() {
      await fs.rm(work, { recursive: true, force: true })
    },
  }
}
