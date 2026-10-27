import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // The sandbox preview loads the dev server cross-origin. dev.log measured
  // Next BLOCKING the preview origin from /_next/* with the old leading-dot
  // entry — Next expects an asterisk subdomain wildcard, and the blocked HMR
  // client kept the panel frozen ("page freeze constantly", 2026-10-28).
  allowedDevOrigins: ["*.space-z.ai"],
};

export default nextConfig;
