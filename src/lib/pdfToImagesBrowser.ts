/**
 * Browser-only: rasterize PDF pages with Mozilla pdf.js (no server canvas / GM).
 * Safe for Vercel — runs entirely in the user’s browser.
 */

const PDFJS_VERSION = "4.10.38";

/** Default render scale (higher = sharper, larger uploads). */
const DEFAULT_SCALE = 1.75;

export async function renderPdfFileToPngDataUrls(file: File, maxPages: number): Promise<string[]> {
  if (typeof window === "undefined") {
    throw new Error("renderPdfFileToPngDataUrls is browser-only");
  }

  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist");

  GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;

  try {
    const pageCount = Math.min(pdf.numPages, Math.max(1, maxPages));
    const urls: string[] = [];

    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(DEFAULT_SCALE, 2000 / Math.max(base.width, 1));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Could not get 2D canvas context");

      await page.render({ canvasContext: ctx, viewport }).promise;
      urls.push(canvas.toDataURL("image/png"));
    }

    return urls;
  } finally {
    await pdf.destroy();
  }
}
