import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /** Let Next resolve `unpdf` + its `unpdf/pdfjs` bundle normally (no pdf-parse worker tracing). */
  serverExternalPackages: ["unpdf", "@napi-rs/canvas", "pdf2pic", "gm"],
  transpilePackages: ["pdfjs-dist"],
};

export default nextConfig;
