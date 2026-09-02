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
        hostname: '*',
      },
    ],
  },
};

export default nextConfig;
