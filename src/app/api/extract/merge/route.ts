import { NextResponse } from "next/server";
import OpenAI, { APIError } from "openai";
import { MERGE_PAGE_EXTRACTIONS_PROMPT } from "@/lib/extractionSchemaPrompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JSON_OBJECT_FORMAT = { type: "json_object" as const };

function getOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key?.trim()) return null;
  return new OpenAI({
    apiKey: key,
    timeout: Number(process.env.OPENAI_TIMEOUT_MS) || 300_000,
  });
}

function getModel() {
  return process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
}

export async function POST(req: Request) {
  const client = getOpenAI();
  if (!client) {
    return NextResponse.json(
      { error: "Server is missing OPENAI_API_KEY." },
      { status: 503 },
    );
  }

  let body: { extractions?: unknown[] };
  try {
    body = (await req.json()) as { extractions?: unknown[] };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.extractions) || body.extractions.length === 0) {
    return NextResponse.json(
      { error: "Body must include extractions: non-empty array" },
      { status: 400 },
    );
  }

  const model = getModel();
  const maxTokens = Number(process.env.OPENAI_MAX_COMPLETION_TOKENS);
  const maxCompletionTokens =
    Number.isFinite(maxTokens) && maxTokens > 0 ? Math.min(maxTokens, 128000) : 16384;

  try {
    const completion = await client.chat.completions.create({
      model,
      response_format: JSON_OBJECT_FORMAT,
      max_completion_tokens: maxCompletionTokens,
      messages: [
        { role: "system", content: MERGE_PAGE_EXTRACTIONS_PROMPT },
        {
          role: "user",
          content: `Merge these page extractions (in order) into one JSON object:\n${JSON.stringify({ page_extractions: body.extractions })}`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (raw == null || raw === "") {
      return NextResponse.json({ error: "Empty merge response from model" }, { status: 502 });
    }
    let data: unknown;
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      return NextResponse.json({ error: "Model returned invalid JSON" }, { status: 502 });
    }

    return NextResponse.json({ data, model });
  } catch (e) {
    console.error("[api/extract/merge]", e);
    if (e instanceof APIError) {
      return NextResponse.json(
        { error: e.message, code: e.code, request_id: e.requestID },
        { status: typeof e.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Merge failed" },
      { status: 500 },
    );
  }
}
