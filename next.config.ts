import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // The sandbox preview loads the dev server cross-origin; allow the gateway host suffix.
  allowedDevOrigins: [".space-z.ai"],
};

export default nextConfig;
