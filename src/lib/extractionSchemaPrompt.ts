/**
 * Open-ended extraction: no fixed JSON Schema — the model structures the document freely
 * using nested objects/arrays, so every visible field can appear without schema limits.
 */

export const UNLIMITED_DOCUMENT_EXTRACTION_PROMPT = `You extract data from insurance / ACORD / commercial property schedules and similar forms.

**Output:** Return a single JSON object (no markdown, no code fences). There is NO fixed field list: organize the content in whatever nested structure best matches the document (sections, tables, repeating premises/buildings, headers, footers, checkboxes, signatures, state lists, etc.).

**Completeness:**
- Include **every** label, value, table cell, row, column header, code, amount, date, name, and note that you can read.
- Represent checkboxes and yes/no as booleans when clear; otherwise use strings or null.
- Repeating blocks (multiple premises, coverage lines, endorsements) → use arrays of objects.
- If something does not fit a neat key, use descriptive keys, or \`additional_fields\` / \`unlabeled\` / \`footnotes\` arrays of { "label"?: string, "value": string }.
- Preserve **digits and spelling** for addresses, policy numbers, and codes; note uncertainty in \`transcription_notes\` only when needed.

**Multi-page PDFs:** The user message may state how many pages there are and include lines like \`### PDF_PAGE 2 OF 3 ###\` between page texts. You MUST extract content from **every** page, not only the first. Merge or nest sections logically (e.g. continued tables, signatures on last page). Do not set "current page" to 1 unless the source truly has a single page.

**PDF text:** Reading order may be wrong — infer structure from labels (e.g. "PREMISES", "COVERAGE") and tables.

**Numbers:** Parse currency and counts as JSON numbers where appropriate; keep IDs as strings if they have leading zeros.

**Do not** omit visible content to save space. If the document is huge, still include all distinct fields; summarize only if truly redundant.`;
