"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { removeNullOrBlankDeep } from "@/lib/removeNullOrBlank";

type ProcessingKind = "openai-vision" | "openai-pdf";

type ResultPayload = {
  source: { fileName: string; mimeType: string };
  extractedText?: string;
  processing: ProcessingKind;
  openAiModel?: string;
  structured?: unknown;
  inputTruncated?: boolean;
  inputCharLimit?: number;
  pdfPageCount?: number;
};

function buildDisplayObject(payload: ResultPayload | null): unknown | null {
  if (!payload) return null;
  return {
    source: payload.source,
    processing: payload.processing,
    model: payload.openAiModel,
    ...(payload.pdfPageCount != null ? { pdf_pages_extracted: payload.pdfPageCount } : {}),
    ...(payload.inputTruncated
      ? {
          warning: `PDF text was truncated at ${payload.inputCharLimit ?? "?"} characters before sending to the model. Raise MAX_PDF_INPUT_CHARS on the server if needed.`,
        }
      : {}),
    extraction: payload.structured,
  };
}

export function OcrJsonDemo() {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rawResult, setRawResult] = useState<ResultPayload | null>(null);
  const [stripBlanks, setStripBlanks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const displayValue = useMemo(() => {
    const obj = buildDisplayObject(rawResult);
    if (!obj) return null;
    if (!stripBlanks) return obj;
    const cleaned = removeNullOrBlankDeep(obj);
    return cleaned === undefined ? null : cleaned;
  }, [rawResult, stripBlanks]);

  const jsonText = useMemo(() => {
    if (displayValue === null) return "";
    try {
      return JSON.stringify(displayValue, null, 2);
    } catch {
      return String(displayValue);
    }
  }, [displayValue]);

  const processFile = useCallback(
    async (file: File) => {
      setError(null);
      setRawResult(null);
      setStripBlanks(false);
      setProgress("");
      setBusy(true);

      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      const isImage = file.type.startsWith("image/");

      if (!isPdf && !isImage) {
        setError("Please upload an image (PNG, JPEG, WebP, …) or a PDF.");
        setBusy(false);
        return;
      }

      try {
        if (isImage) {
          const url = URL.createObjectURL(file);
          setPreviewUrl(url);
        } else {
          setPreviewUrl(null);
        }

        setProgress("Processing…");
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch("/api/extract", { method: "POST", body: formData });
        const body = (await res.json()) as {
          error?: string;
          data?: unknown;
          model?: string;
          kind?: "image" | "pdf";
          inputTruncated?: boolean;
          inputCharLimit?: number;
          pdfPageCount?: number;
        };

        if (!res.ok) {
          throw new Error(body.error || `Request failed (${res.status})`);
        }

        const structured = body.data;
        let extractedSnippet: string | undefined;
        if (structured && typeof structured === "object") {
          const o = structured as Record<string, unknown>;
          if (typeof o.full_text === "string") extractedSnippet = o.full_text;
          else if (typeof o.transcription_notes === "string") extractedSnippet = o.transcription_notes;
        }

        setRawResult({
          source: { fileName: file.name, mimeType: file.type || (isPdf ? "application/pdf" : "image/*") },
          processing: body.kind === "pdf" ? "openai-pdf" : "openai-vision",
          openAiModel: body.model,
          structured,
          extractedText: extractedSnippet,
          inputTruncated: body.inputTruncated,
          inputCharLimit: body.inputCharLimit,
          pdfPageCount: body.pdfPageCount,
        });
        setProgress("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Processing failed.");
        setPreviewUrl(null);
      } finally {
        setBusy(false);
      }
    },
    [previewUrl],
  );

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void processFile(file);
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Image & document → JSON
        </h1>
      </header>

      <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-zinc-300 bg-zinc-50/80 px-6 py-12 transition-colors hover:border-zinc-400 hover:bg-zinc-100/80 dark:border-zinc-600 dark:bg-zinc-900/40 dark:hover:border-zinc-500">
        <input
          type="file"
          accept="image/*,application/pdf,.pdf"
          className="sr-only"
          disabled={busy}
          onChange={onInputChange}
        />
        <span className="text-sm font-medium text-foreground">
          {busy ? "Working…" : "Click or drop an image / PDF"}
        </span>
        {progress ? (
          <span className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{progress}</span>
        ) : null}
      </label>

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">
          {error}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2 lg:gap-8">
        <section className="flex min-h-[280px] flex-col rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Source
          </h2>
          <div className="flex flex-1 items-center justify-center overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-900">
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt="Uploaded preview"
                className="max-h-[min(420px,50vh)] w-full object-contain"
              />
            ) : rawResult?.source.mimeType.includes("pdf") ? (
              <div className="p-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
                <p className="font-medium text-foreground">{rawResult.source.fileName}</p>
                <p className="mt-2">PDF — processed on the server.</p>
              </div>
            ) : (
              <p className="px-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
                No file yet.
              </p>
            )}
          </div>
        </section>

        <section className="flex min-h-[280px] flex-col rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-3 flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                JSON
              </h2>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="size-4 rounded border-zinc-300 accent-zinc-900 dark:border-zinc-600 dark:accent-zinc-100"
                  checked={stripBlanks}
                  onChange={(e) => setStripBlanks(e.target.checked)}
                  disabled={!rawResult}
                />
                Remove null / blank values
              </label>
            </div>
            {rawResult ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {stripBlanks
                  ? "Showing a cleaned copy with null, empty strings, and empty objects/arrays removed."
                  : "Showing the full JSON, including null and empty string values."}
              </p>
            ) : null}
          </div>
          <pre className="max-h-[min(420px,50vh)] flex-1 overflow-auto rounded-lg bg-zinc-950 p-4 text-xs leading-relaxed text-zinc-100 dark:bg-black">
            {jsonText || (
              <span className="text-zinc-500">Upload a file to see JSON output.</span>
            )}
          </pre>
        </section>
      </div>
    </div>
  );
}
