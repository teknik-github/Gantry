import type { Kysely } from "kysely"
import { vi } from "vitest"

import type { Database } from "@/lib/server/db/schema"

/**
 * A stand-in for the request scope of Server Actions and route handlers in
 * unit tests: the cookies and headers that next/headers would give, the
 * database getDb() returns (a throwaway one per test file, never the shared
 * .test-data/unit/gantry.db, see tests/unit/agent-tunnel.test.ts), and spies
 * for refresh() and redirect().
 *
 * Use it from vi.mock factories (they are hoisted above imports, so import
 * this module inside them):
 *
 *   vi.mock("next/headers", async () => (await import("../helpers/request-context")).nextHeaders)
 *   vi.mock("next/cache", async () => (await import("../helpers/request-context")).nextCache)
 *   vi.mock("next/navigation", async () => (await import("../helpers/request-context")).nextNavigation)
 *   vi.mock("@/lib/server/db", async () => (await import("../helpers/request-context")).serverDb)
 *   vi.mock("next/server", async (original) => (await import("../helpers/request-context")).nextServer(original))
 */
export const request = {
  cookies: new Map<string, string>(),
  headers: new Headers(),
  db: null as Kysely<Database> | null,
}

/** Starts a new request: no cookies, no headers (the database is kept). */
export function resetRequest() {
  request.cookies.clear()
  request.headers = new Headers()
  nextCache.refresh.mockClear()
  connection.mockClear()
}

const cookieStore = {
  get: (name: string) => (request.cookies.has(name) ? { name, value: request.cookies.get(name)! } : undefined),
  has: (name: string) => request.cookies.has(name),
  getAll: () => [...request.cookies].map(([name, value]) => ({ name, value })),
  set: (name: string, value: string) => {
    request.cookies.set(name, value)
    return cookieStore
  },
  delete: (name: string) => {
    request.cookies.delete(name)
    return cookieStore
  },
}

export const nextHeaders = {
  cookies: async () => cookieStore,
  headers: async () => request.headers,
}

/**
 * next/server as it is, except connection(): Next's throws outside its
 * request scope. Here it resolves at once, like it does for a real request;
 * a test can make it hang, as it does in a prefetch render, with
 * `connection.mockReturnValueOnce(new Promise(() => {}))`.
 */
export const connection = vi.fn(async () => {})

export async function nextServer(original: () => Promise<typeof import("next/server")>) {
  return { ...(await original()), connection }
}

export const nextCache = {
  refresh: vi.fn(),
  revalidatePath: vi.fn(),
}

/** redirect() throws like Next's does, so the code after it never runs. */
export class RedirectError extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT ${url}`)
  }
}

export const nextNavigation = {
  redirect: (url: string) => {
    throw new RedirectError(url)
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND")
  },
}

export const serverDb = {
  getDb: async () => {
    if (!request.db) throw new Error("no test database (set request.db in beforeAll)")
    return request.db
  },
}
