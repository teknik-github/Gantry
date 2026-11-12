import os from "node:os"

import type { NextConfig } from "next"

// Hosts allowed to load dev resources (scripts, HMR) when not on localhost:
// every address of this machine, so a new DHCP lease doesn't leave the page
// without its JavaScript, plus GANTRY_DEV_ORIGINS (comma-separated) for names
// or proxies in front of it.
const devOrigins = [
  ...Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a !== undefined)
    .map((a) => a.address),
  ...(process.env.GANTRY_DEV_ORIGINS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
]

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  // Self-contained server bundle for the Docker image.
  output: "standalone",
  serverExternalPackages: ["mysql2"],
  experimental: {
    // Every Gantry page is session-gated live Docker state that can't be
    // prefetched, so only validate segments that explicitly opt into `instant`.
    instantInsights: { validationLevel: "manual-warning" },
  },
  poweredByHeader: false,
  allowedDevOrigins: devOrigins,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async redirects() {
    return [{ source: "/", destination: "/dashboard", permanent: false }]
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ]
  },
}

export default nextConfig
