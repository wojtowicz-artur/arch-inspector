import { createHash } from "node:crypto";

/**
 * Produce a JSON-compatible value with object keys in a deterministic order.
 * Arrays keep their order because some IR fields are ordered witnesses rather
 * than sets.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compare(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

export function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
