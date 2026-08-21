import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async redirects() {
    return [
      {
        source: "/",
        destination: "/mission-control",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
