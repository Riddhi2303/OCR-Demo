import { PDFParse } from "pdf-parse";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { configurePdfJsWorkerForServer } from "@/lib/configurePdfWorker";
import { UNLIMITED_DOCUMENT_EXTRACTION_PROMPT } from "@/lib/extractionSchemaPrompt";

export const runtime = "nodejs";
export const maxDuration = 300;

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
  return process.env.OPENAI_MODEL?.trim() || "gpt-5";
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

async function extractStructuredFromPdfText(
  client: OpenAI,
  model: string,
  rawText: string,
  truncated: boolean,
  pdfPageCount: number,
) {
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
          ? `PDF: ${pdfPageCount} page(s). Extract key fields and tables into JSON (all pages).${truncated ? " Text was truncated." : ""}\n\n---\n${rawText}\n---`
          : `This PDF has ${pdfPageCount} page(s) of extractable text. The text includes \`### PDF_PAGE page_number OF total_number ###\` markers between pages — process ALL pages (1 through ${pdfPageCount}). Extract the full document into rich JSON: every field, table, section, and note from every page.${truncated ? " Note: input was truncated; extract as much as possible from the text below." : ""}\n\n---\n${rawText}\n---`,
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
  const client = getOpenAI();
  if (!client) {
    return NextResponse.json(
      { error: "Server is missing OPENAI_API_KEY. Add it to .env.local and restart the dev server." },
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
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Missing file field" }, { status: 400 });
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_BYTES / (1024 * 1024)} MB)` },
      { status: 413 },
    );
  }

  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
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

    configurePdfJsWorkerForServer();
    const parser = new PDFParse({ data: buffer });
    const textResult = await parser.getText({
      pageJoiner: "\n\n### PDF_PAGE page_number OF total_number ###\n\n",
    });
    const pdfPageCount = textResult.total;
    await parser.destroy();
    const rawText = textResult.text?.trim() ?? "";

    if (!rawText) {
      return NextResponse.json(
        {
          error:
            "No extractable text in this PDF (it may be scanned). Try uploading page images with OpenAI mode instead.",
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
    );
    return NextResponse.json({
      data,
      model,
      kind: "pdf" as const,
      pdfPageCount,
      fastMode: isFastMode(),
      qualityMode: !isFastMode(),
      ...(textTruncated ? { inputTruncated: true, inputCharLimit: pdfCharLimit } : {}),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Extraction failed";
    const status =
      message.includes("JSON") || message.includes("Empty model") || message.includes("refused") ? 502 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
