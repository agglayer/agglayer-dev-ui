import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  // Next 16 holds a per-distDir `flock` lock (`<distDir>/dev/lock`) and refuses
  // to start a second `next dev` that resolves to the same distDir. The E2E
  // suite runs two dev servers concurrently from this one directory (the shared
  // chromium server on :3000 and the partial-failure project's server on :3100
  // -- see playwright.config.ts), so the second one must resolve to a distinct
  // distDir or Next aborts it with "Another next dev server is already running".
  // Only the partial-failure webServer sets NEXT_DIST_DIR; production
  // build/export leaves it unset and keeps the default `.next`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*'
      }
    ]
  },
  // Turbopack's persistent build cache (`next build`, as opposed to `next
  // dev`, where this already defaults to true) is still experimental and
  // defaults to false -- opt in ONLY for the loadtest tool's own `build-ui`
  // command (loadtest/ui/build.ts sets LOADTEST_UI_BUILD=true), so every
  // other build path (production, Cloudflare Workers deploy, Docker image
  // build) keeps its current, unchanged behavior. build-ui repeatedly
  // rebuilds this same app (once per loadtest run) with only config.json
  // changing, which is exactly the repeat-build scenario this cache exists
  // for (bridge-loadtest-plan.md S09).
  ...(process.env.LOADTEST_UI_BUILD === 'true'
    ? { experimental: { turbopackFileSystemCacheForBuild: true } }
    : {})
};

export default nextConfig;
