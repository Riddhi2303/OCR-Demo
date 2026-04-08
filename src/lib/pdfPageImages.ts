import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type PdfImageEngine = "pdf2pic" | "unpdf";

/**
 * Convert PDF buffer to PNG buffers (one per page, capped at maxPages).
 *
 * - **pdf2pic** (GraphicsMagick + Ghostscript): set `PDF_IMAGE_ENGINE=pdf2pic` or `auto` (tries first).
 * - **unpdf** + **@napi-rs/canvas**: fallback; works on Vercel without GM/GS.
 *
 * **pdf-poppler** only supports macOS/Windows in npm; not used here.
 */
export async function pdfBufferToPngPages(
  buffer: Buffer,
  maxPages: number,
): Promise<{ pages: Buffer[]; engine: PdfImageEngine }> {
  const pref = (process.env.PDF_IMAGE_ENGINE || "auto").toLowerCase();

  if (pref === "unpdf") {
    return { pages: await pngPagesViaUnpdf(buffer, maxPages), engine: "unpdf" };
  }

  if (pref === "pdf2pic") {
    return { pages: await pngPagesViaPdf2pic(buffer, maxPages), engine: "pdf2pic" };
  }

  try {
    return { pages: await pngPagesViaPdf2pic(buffer, maxPages), engine: "pdf2pic" };
  } catch (e) {
    console.warn("[pdfPageImages] pdf2pic failed, falling back to unpdf:", e);
    return { pages: await pngPagesViaUnpdf(buffer, maxPages), engine: "unpdf" };
  }
}

async function pngPagesViaPdf2pic(buffer: Buffer, maxPages: number): Promise<Buffer[]> {
  const { fromBuffer } = await import("pdf2pic");
  const savePath = join(tmpdir(), `pdf2pic-${randomBytes(8).toString("hex")}`);
  await mkdir(savePath, { recursive: true });

  const density = Number(process.env.PDF2PIC_DENSITY);
  const width = Number(process.env.PDF2PIC_WIDTH);
  const height = Number(process.env.PDF2PIC_HEIGHT);

  const convert = fromBuffer(buffer, {
    density: Number.isFinite(density) && density > 0 ? density : 150,
    format: "png",
    width: Number.isFinite(width) && width > 0 ? width : 1400,
    height: Number.isFinite(height) && height > 0 ? height : 2000,
    preserveAspectRatio: true,
    savePath,
    saveFilename: "page",
  });

  const all = await convert.bulk(-1, { responseType: "buffer" });
  const sorted = [...all].sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
  const buffers = sorted
    .slice(0, maxPages)
    .map((r) => r.buffer)
    .filter((b): b is Buffer => Buffer.isBuffer(b));
  if (buffers.length === 0) {
    throw new Error("pdf2pic returned no page images (install GraphicsMagick + Ghostscript, or set PDF_IMAGE_ENGINE=unpdf)");
  }
  return buffers;
}

async function pngPagesViaUnpdf(buffer: Buffer, maxPages: number): Promise<Buffer[]> {
  const { renderPageAsImage, getDocumentProxy } = await import("unpdf");
  const canvasMod = await import("@napi-rs/canvas");
  const scaleEnv = Number(process.env.OPENAI_PDF_RENDER_SCALE);
  const scale = Number.isFinite(scaleEnv) && scaleEnv > 0 ? scaleEnv : 1.5;

  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  try {
    const n = Math.min(maxPages, pdf.numPages);
    const out: Buffer[] = [];
    for (let i = 1; i <= n; i++) {
      const ab = await renderPageAsImage(pdf, i, {
        canvasImport: () => Promise.resolve(canvasMod),
        scale,
      });
      out.push(Buffer.from(ab));
    }
    return out;
  } finally {
    const destroy = (pdf as { destroy?: () => Promise<void> }).destroy;
    if (typeof destroy === "function") await destroy.call(pdf);
  }
}
