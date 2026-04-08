import type { ChatCompletion } from "openai/resources/chat/completions";
import { NextRequest, NextResponse } from "next/server";
import OpenAI, { APIError } from "openai";
import {
  MERGE_PAGE_EXTRACTIONS_PROMPT,
  UNLIMITED_DOCUMENT_EXTRACTION_PROMPT,
} from "@/lib/extractionSchemaPrompt";
import { pdfBufferToPngPages } from "@/lib/pdfPageImages";

/** PDF text uses `unpdf` (serverless-safe). `pdf-parse` + pdf.js workers often fail only on Vercel. */

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function isUploadFile(value: FormDataEntryValue | null): value is File {
  return typeof value === "object" && value !== null && typeof (value as Blob).arrayBuffer === "function";
}

const MAX_BYTES = 32 * 1024 * 1024;

/** Upper bound for PDF text sent to the model. Lower = faster API calls (less input to process). */
const MAX_PDF_TEXT_CHARS = Number(process.env.MAX_PDF_INPUT_CHARS) || 450_000;

/** When OPENAI_FAST=1, cap PDF text earlier to reduce latency (still multi-page, but less token load). */
const FAST_PDF_CHAR_CAP = Number(process.env.OPENAI_FAST_MAX_PDF_CHARS) || 120_000;

const JSON_OBJECT_FORMAT = { type: "json_object" as const };

function getOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key?.trim()) return null;
  return new OpenAI({
    apiKey: key,
    timeout: Number(process.env.OPENAI_TIMEOUT_MS) || 300_000,
  });
}

/** Default gpt-5 when unset — best for extraction accuracy (slower). Set OPENAI_MODEL=gpt-4o-mini for speed/cost. */
function getModel() {
  return process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
}

function isFastMode() {
  return process.env.OPENAI_FAST === "1" || process.env.OPENAI_FAST === "true";
}

function isReasoningFamilyModel(model: string) {
  const m = model.toLowerCase();
  return (
    m.startsWith("gpt-5") ||
    m.startsWith("o1") ||
    m.startsWith("o3") ||
    m.startsWith("o4") ||
    m.startsWith("o-") ||
    /(^|[-/])o[0-9]/.test(m)
  );
}

/**
 * Vision detail: `high` improves small print / scans (default when not in fast mode).
 * OPENAI_IMAGE_DETAIL overrides. Fast mode defaults to `low` for latency.
 */
function getImageDetail(): "auto" | "low" | "high" {
  const d = process.env.OPENAI_IMAGE_DETAIL?.trim().toLowerCase();
  if (d === "high" || d === "low" || d === "auto") return d;
  return isFastMode() ? "low" : "high";
}

/**
 * GPT-5 / reasoning: `medium` default when optimizing for accuracy (slower, more thorough).
 * `minimal`/`low` in fast mode. Override with OPENAI_REASONING_EFFORT.
 */
function reasoningParams(model: string): { reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" } {
  if (!isReasoningFamilyModel(model)) return {};
  const raw = process.env.OPENAI_REASONING_EFFORT?.trim().toLowerCase();
  const allowed = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
  const effort =
    raw && allowed.has(raw)
      ? (raw as "none" | "minimal" | "low" | "medium" | "high" | "xhigh")
      : isFastMode()
        ? "minimal"
        : "medium";
  return { reasoning_effort: effort };
}

function getMaxCompletionTokens(model: string) {
  const fromEnv = Number(process.env.OPENAI_MAX_COMPLETION_TOKENS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.min(fromEnv, 128000);
  if (isFastMode()) return 8192;
  return isReasoningFamilyModel(model) ? 65536 : 16384;
}

function getEffectivePdfCharLimit(): number {
  if (isFastMode()) return Math.min(FAST_PDF_CHAR_CAP, MAX_PDF_TEXT_CHARS);
  return MAX_PDF_TEXT_CHARS;
}

function parseAssistantJson(completion: ChatCompletion): unknown {
  const choice = completion.choices[0];
  if (!choice) throw new Error("No completion choice from the model");
  const msg = choice.message;
  if (msg.refusal) throw new Error(`Model refused: ${msg.refusal}`);
  const raw = msg.content;
  if (raw == null || raw === "") {
    throw new Error(
      `Empty model output (finish_reason=${String(choice.finish_reason)}). For GPT-5, raise OPENAI_MAX_COMPLETION_TOKENS or lower OPENAI_REASONING_EFFORT; ensure max_completion_tokens is not entirely consumed by reasoning.`,
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Model returned invalid JSON");
  }
}

async function extractStructuredFromImage(client: OpenAI, model: string, base64: string, mime: string) {
  const completion = await client.chat.completions.create({
    model,
    ...reasoningParams(model),
    response_format: JSON_OBJECT_FORMAT,
    max_completion_tokens: getMaxCompletionTokens(model),
    messages: [
      { role: "system", content: UNLIMITED_DOCUMENT_EXTRACTION_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: isFastMode()
              ? "Extract this document into JSON. Include main fields, tables, and values; use nested objects as needed."
              : "Extract everything visible on this document into comprehensive JSON. Use nested objects and arrays freely so no field is dropped.",
          },
          {
            type: "image_url",
            image_url: { url: `data:${mime};base64,${base64}`, detail: getImageDetail() },
          },
        ],
      },
    ],
  });
  return parseAssistantJson(completion);
}

/** Heuristic: scanned / XFA PDFs often yield very little text per page. */
function isSparsePdfText(rawText: string, pageCount: number): boolean {
  if (pageCount <= 0) return false;
  const perPage = rawText.length / pageCount;
  return rawText.length < 500 || perPage < 120;
}

function maxVisionPages(totalPages: number): number {
  const cap = Number(process.env.OPENAI_PDF_MAX_VISION_PAGES);
  const n = Number.isFinite(cap) && cap > 0 ? cap : 12;
  return Math.min(totalPages, Math.max(1, n));
}

function visionDetailForPageCount(renderedPages: number, totalPages: number): "low" | "high" | "auto" {
  if (renderedPages > 5 || totalPages > 4) return "low";
  return getImageDetail();
}

/** One vision call per rendered page, then one merge call → single JSON. */
async function extractStructuredFromPdfPerPageVision(
  client: OpenAI,
  model: string,
  buffer: Buffer,
  totalPages: number,
): Promise<{ data: unknown; imageEngine: "pdf2pic" | "unpdf"; renderedPages: number }> {
  const maxPages = maxVisionPages(totalPages);
  const { pages: pngPages, engine: imageEngine } = await pdfBufferToPngPages(buffer, maxPages);
  const detail = visionDetailForPageCount(pngPages.length, totalPages);

  const pageExtractions: unknown[] = [];
  for (let i = 0; i < pngPages.length; i++) {
    const pageNum = i + 1;
    const b64 = pngPages[i].toString("base64");
    const userText = isFastMode()
      ? `PDF page ${pageNum} of ${totalPages}. Extract visible fields into JSON.`
      : `This is page ${pageNum} of ${totalPages} from the same PDF. Extract everything visible on this page only (forms, tables, handwriting, checkboxes). Return one JSON object. Optional: include "__page": ${pageNum}. Do not invent content from other pages.`;

    const completion = await client.chat.completions.create({
      model,
      ...reasoningParams(model),
      response_format: JSON_OBJECT_FORMAT,
      max_completion_tokens: getMaxCompletionTokens(model),
      messages: [
        { role: "system", content: UNLIMITED_DOCUMENT_EXTRACTION_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${b64}`, detail },
            },
          ],
        },
      ],
    });
    pageExtractions.push(parseAssistantJson(completion));
  }

  const mergeCompletion = await client.chat.completions.create({
    model,
    ...reasoningParams(model),
    response_format: JSON_OBJECT_FORMAT,
    max_completion_tokens: getMaxCompletionTokens(model),
    messages: [
      { role: "system", content: MERGE_PAGE_EXTRACTIONS_PROMPT },
      {
        role: "user",
        content: `The PDF has ${totalPages} page(s); below are JSON extractions from ${pngPages.length} rendered page image(s) in order.\n\n${JSON.stringify({ page_extractions: pageExtractions })}\n\nReturn one merged JSON object for the full document.${totalPages > pngPages.length ? ` Note: pages ${pngPages.length + 1}–${totalPages} were not rendered; mention in transcription_notes if relevant.` : ""}`,
      },
    ],
  });

  return {
    data: parseAssistantJson(mergeCompletion),
    imageEngine,
    renderedPages: pngPages.length,
  };
}

async function extractStructuredFromPdfText(
  client: OpenAI,
  model: string,
  rawText: string,
  truncated: boolean,
  pdfPageCount: number,
  sourceFileName: string,
  sparseText: boolean,
) {
  const sparseHint = sparseText
    ? `\n\n**Sparse text warning:** The extractable text below is short for this page count (common for scanned PDFs or XFA forms). Extract every fragment; do **not** fill the JSON with only the filename or generic "submission" headers. If content is missing, say so in \`transcription_notes\` and list fragments under \`raw_text_fragments\` or similar.`
    : "";

  const nameLine = `Original file name (for context only; extract real fields from the PDF text, not from this string alone): ${sourceFileName}`;

  const completion = await client.chat.completions.create({
    model,
    ...reasoningParams(model),
    response_format: JSON_OBJECT_FORMAT,
    max_completion_tokens: getMaxCompletionTokens(model),
    messages: [
      { role: "system", content: UNLIMITED_DOCUMENT_EXTRACTION_PROMPT },
      {
        role: "user",
        content: isFastMode()
          ? `${nameLine}\nPDF: ${pdfPageCount} page(s). Extract key fields and tables into JSON (all pages).${truncated ? " Text was truncated." : ""}${sparseHint}\n\n---\n${rawText}\n---`
          : `${nameLine}\nThis PDF has ${pdfPageCount} page(s) of extractable text. The text includes \`### PDF_PAGE page_number OF total_number ###\` markers between pages — process ALL pages (1 through ${pdfPageCount}). Extract the full application/schedule content into rich JSON: named insureds, premises, coverages, limits, dates, amounts, tables, checkboxes, and notes — not only document titles or file-related labels.${truncated ? " Note: input was truncated; extract as much as possible from the text below." : ""}${sparseHint}\n\n---\n${rawText}\n---`,
      },
    ],
  });
  return parseAssistantJson(completion);
}

export async function GET() {
  return NextResponse.json({
    message: "Use POST with multipart/form-data and a form field named \"file\" (image or PDF).",
    hint: "Default: GPT-5 quality (high image detail, medium reasoning, large token budget). Set OPENAI_FAST=1 for lower latency.",
  });
}

export async function POST(req: NextRequest) {
  try {
    return await handlePost(req);
  } catch (fatal) {
    console.error("[api/extract] unhandled", fatal);
    return NextResponse.json(
      { error: fatal instanceof Error ? fatal.message : "Internal server error" },
      { status: 500 },
    );
  }
}

async function handlePost(req: NextRequest) {
  const client = getOpenAI();
  if (!client) {
    return NextResponse.json(
      {
        error:
          "Server is missing OPENAI_API_KEY. Set OPENAI_API_KEY in the host environment (e.g. Vercel Project → Settings → Environment Variables) and redeploy.",
      },
      { status: 503 },
    );
  }

  const model = getModel();
  const pdfCharLimit = getEffectivePdfCharLimit();

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!isUploadFile(file)) {
    return NextResponse.json({ error: "Missing file field" }, { status: 400 });
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_BYTES / (1024 * 1024)} MB)` },
      { status: 413 },
    );
  }

  const fileName = file.name;
  const isPdf = file.type === "application/pdf" || fileName.toLowerCase().endsWith(".pdf");
  const isImage = file.type.startsWith("image/");

  if (!isPdf && !isImage) {
    return NextResponse.json(
      { error: "Unsupported type. Send an image or application/pdf." },
      { status: 400 },
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());

    if (isImage) {
      const mime = file.type || "image/png";
      const data = await extractStructuredFromImage(client, model, buffer.toString("base64"), mime);
      return NextResponse.json({
        data,
        model,
        kind: "image" as const,
        fastMode: isFastMode(),
        qualityMode: !isFastMode(),
      });
    }

    const { extractText } = await import("unpdf");
    const { totalPages, text: pageTexts } = await extractText(new Uint8Array(buffer), {
      mergePages: false,
    });
    const pdfPageCount = totalPages;
    const parts: string[] = [];
    for (let i = 0; i < pageTexts.length; i++) {
      parts.push(pageTexts[i] ?? "");
      if (i < pageTexts.length - 1) {
        parts.push(`\n\n### PDF_PAGE ${i + 1} OF ${pdfPageCount} ###\n\n`);
      }
    }
    const rawText = parts.join("").trim();

    const sparseText = rawText.length === 0 || isSparsePdfText(rawText, pdfPageCount);
    const visionFallbackEnabled = process.env.OPENAI_PDF_VISION_FALLBACK !== "0";

    if (sparseText && visionFallbackEnabled) {
      try {
        const { data, imageEngine, renderedPages } = await extractStructuredFromPdfPerPageVision(
          client,
          model,
          buffer,
          pdfPageCount,
        );
        const cap = maxVisionPages(pdfPageCount);
        return NextResponse.json({
          data,
          model,
          kind: "pdf" as const,
          pdfPageCount,
          fastMode: isFastMode(),
          qualityMode: !isFastMode(),
          extractedTextChars: rawText.length,
          usedVisionFallback: true as const,
          usedPerPageVision: true as const,
          pdfImageEngine: imageEngine,
          visionPagesRendered: renderedPages,
          ...(pdfPageCount > renderedPages
            ? {
                visionPagesOmitted: pdfPageCount - renderedPages,
                hint: `Raise OPENAI_PDF_MAX_VISION_PAGES to process more pages (cap ${cap}).`,
              }
            : {}),
        });
      } catch (visionErr) {
        console.error("[api/extract] PDF vision fallback failed", visionErr);
        if (!rawText) {
          return NextResponse.json(
            {
              error:
                "This PDF has no extractable text (likely scanned). Automatic page rendering failed.",
              detail: visionErr instanceof Error ? visionErr.message : String(visionErr),
            },
            { status: 422 },
          );
        }
        /* fall through to text-only path */
      }
    }

    if (!rawText) {
      return NextResponse.json(
        {
          error:
            "No extractable text in this PDF (it may be scanned). Set OPENAI_PDF_VISION_FALLBACK=1 or upload page images.",
        },
        { status: 422 },
      );
    }

    const textTruncated = rawText.length > pdfCharLimit;
    const bodyText = textTruncated ? rawText.slice(0, pdfCharLimit) : rawText;
    const header = `PDF_PAGE_COUNT: ${pdfPageCount}\nExtract text from all ${pdfPageCount} page(s). Sections below are separated by ### PDF_PAGE … ### markers.\n\n`;
    const data = await extractStructuredFromPdfText(
      client,
      model,
      header + bodyText,
      textTruncated,
      pdfPageCount,
      fileName,
      isSparsePdfText(rawText, pdfPageCount),
    );
    return NextResponse.json({
      data,
      model,
      kind: "pdf" as const,
      pdfPageCount,
      fastMode: isFastMode(),
      qualityMode: !isFastMode(),
      extractedTextChars: rawText.length,
      ...(isSparsePdfText(rawText, pdfPageCount) ? { pdfTextLikelyIncomplete: true as const } : {}),
      ...(textTruncated ? { inputTruncated: true, inputCharLimit: pdfCharLimit } : {}),
    });
  } catch (e) {
    console.error("[api/extract]", e);
    if (e instanceof APIError) {
      const code =
        typeof e.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 502;
      return NextResponse.json(
        {
          error: e.message,
          code: e.code ?? undefined,
          request_id: e.requestID ?? undefined,
        },
        { status: code },
      );
    }
    const message = e instanceof Error ? e.message : "Extraction failed";
    const status =
      message.includes("JSON") || message.includes("Empty model") || message.includes("refused")
        ? 502
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
