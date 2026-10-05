import { createHash } from "node:crypto";

/**
 * Produces the payload fingerprint used by Inbox and idempotency checks.
 * Object keys are sorted recursively and transport metadata is excluded by
 * the caller before this function is invoked.
 */
export function hashCanonicalPayload(payload: unknown): string {
  return createHash("sha256")
    .update(canonicalize(payload))
    .digest("hex");
}
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}
