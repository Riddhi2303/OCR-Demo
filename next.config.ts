import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
  /**
   * Vercel serverless traces only files reachable from static analysis. pdf-parse resolves
   * pdf.worker.mjs at runtime; without this, the worker file can be missing in the lambda → 500/HTML.
   */
  outputFileTracingIncludes: {
    "/api/extract": ["./node_modules/pdfjs-dist/**/*", "./node_modules/pdf-parse/**/*"],
  },
};

export default nextConfig;
