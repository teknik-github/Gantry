// Runs once when a Next.js server instance starts (see the instrumentation
// docs). Startup tasks live in lib/server/startup.ts so they only load in the
// Node.js runtime.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runStartupTasks } = await import("@/lib/server/startup")
    await runStartupTasks()
  }
}
