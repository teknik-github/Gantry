import type { NextConfig } from "next"

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
  // Hosts allowed to load dev resources (HMR etc.) when not on localhost.
  allowedDevOrigins: ["10.8.0.4"],
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
