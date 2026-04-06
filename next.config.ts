import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /** Let Next resolve `unpdf` + its `unpdf/pdfjs` bundle normally (no pdf-parse worker tracing). */
  serverExternalPackages: ["unpdf"],
};

export default nextConfig;
