import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

let configured = false;

/**
 * Resolve pdf.worker.mjs next to the same pdfjs-dist version pdf-parse uses.
 * Uses package resolution from project root so production (Linux, Docker, Vercel) matches npm layout.
 *
 * No runtime import of `pdf-parse` here — that stays in the API route dynamic import so the
 * route module does not load pdfjs on cold start (fixes many serverless hosts).
 */
function resolvePdfWorkerPath(): string {
  const cwd = process.cwd();
  const pkgJson = join(cwd, "package.json");
  if (!existsSync(pkgJson)) {
    throw new Error(
      `PDF worker: package.json not found at ${pkgJson}. Ensure the app runs with cwd = project root on the server.`,
    );
  }

  const require = createRequire(pkgJson);
  const searchRoots = [
    join(cwd, "node_modules", "pdf-parse", "node_modules"),
    join(cwd, "node_modules"),
  ];

  for (const root of searchRoots) {
    if (!existsSync(root)) continue;
    try {
      const pkgPath = require.resolve("pdfjs-dist/package.json", { paths: [root] });
      const worker = join(dirname(pkgPath), "legacy", "build", "pdf.worker.mjs");
      if (existsSync(worker)) return worker;
    } catch {
      continue;
    }
  }

  throw new Error(
    "PDF worker: could not find pdfjs-dist legacy worker. On the server run `npm ci` (or `npm install`) in the app directory so node_modules/pdf-parse/node_modules/pdfjs-dist exists.",
  );
}

/** pdf-parse class shape we need (from dynamic `import("pdf-parse")`). */
type PdfParseModule = { PDFParse: { setWorker: (src: string) => void } };

/**
 * pdf-parse uses pdfjs-dist/legacy; bundlers break default worker resolution.
 * Point GlobalWorkerOptions at the real file on disk before parsing.
 */
export function configurePdfJsWorkerForServer({ PDFParse }: PdfParseModule) {
  if (configured) return;
  const workerPath = resolvePdfWorkerPath();
  PDFParse.setWorker(pathToFileURL(workerPath).href);
  configured = true;
}
