import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PDFParse } from "pdf-parse";

let configured = false;

/**
 * Resolve the worker next to the same pdfjs-dist version pdf-parse uses (often nested 5.4.x),
 * not the hoisted app dependency (e.g. 5.6.x) — mismatched API/worker versions throw at runtime.
 */
function resolvePdfWorkerPath(): string {
  const cwd = process.cwd();
  const nested = join(
    cwd,
    "node_modules",
    "pdf-parse",
    "node_modules",
    "pdfjs-dist",
    "legacy",
    "build",
    "pdf.worker.mjs",
  );
  if (existsSync(nested)) return nested;
  return join(cwd, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs");
}

/**
 * pdf-parse uses pdfjs-dist/legacy; Next/Turbopack bundling breaks default worker resolution.
 * Point GlobalWorkerOptions at the real file on disk before parsing.
 */
export function configurePdfJsWorkerForServer() {
  if (configured) return;
  const workerPath = resolvePdfWorkerPath();
  PDFParse.setWorker(pathToFileURL(workerPath).href);
  configured = true;
}
