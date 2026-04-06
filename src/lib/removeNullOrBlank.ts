/**
 * Recursively removes null, undefined, whitespace-only strings, empty arrays,
 * and empty objects from JSON-compatible data.
 */
export function removeNullOrBlankDeep(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.trim() === "" ? undefined : value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const cleaned = removeNullOrBlankDeep(item);
      if (cleaned === undefined) continue;
      if (typeof cleaned === "string" && cleaned.trim() === "") continue;
      out.push(cleaned);
    }
    return out;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const cleaned = removeNullOrBlankDeep(v);
    if (cleaned === undefined) continue;
    if (typeof cleaned === "string" && cleaned.trim() === "") continue;
    if (Array.isArray(cleaned) && cleaned.length === 0) continue;
    if (
      typeof cleaned === "object" &&
      cleaned !== null &&
      !Array.isArray(cleaned) &&
      Object.keys(cleaned as Record<string, unknown>).length === 0
    ) {
      continue;
    }
    out[k] = cleaned;
  }
  return out;
}
