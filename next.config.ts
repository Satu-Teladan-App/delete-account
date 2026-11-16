import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [{ source: "/hapus-akun", destination: "/hapusakun", permanent: false }];
  },
};

export default nextConfig;
