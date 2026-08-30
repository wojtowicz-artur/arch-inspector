import type { ArchitectureFinding } from "./ir.js";

/** Canonical finding codes that can be selected by the CLI/config policy. */
export const BUILTIN_FAIL_ON_CODES = [
  "architecture/cycle",
  "architecture/unresolved-import",
  "architecture/out-of-scope-import",
  "architecture/dynamic-import-ambiguous",
  "architecture/boundary-violation",
  "architecture/deep-import",
  "architecture/forbidden-dependency",
  "architecture/no-public-entrypoint",
] as const;

const aliases: Readonly<Record<string, string>> = {
  cycles: "architecture/cycle",
  cycle: "architecture/cycle",
  "deep-imports": "architecture/deep-import",
  "deep-import": "architecture/deep-import",
  "forbidden-dependencies": "architecture/forbidden-dependency",
  "forbidden-dependency": "architecture/forbidden-dependency",
};

const builtinCodes = new Set<string>(BUILTIN_FAIL_ON_CODES);
const bareBuiltinCodes = new Set<string>(BUILTIN_FAIL_ON_CODES.map((code) => code.slice("architecture/".length)));

/** Map the short historical spellings to canonical architecture finding codes. */
export function normalizeFailOnSelector(selector: string): string {
  if (aliases[selector]) return aliases[selector];
  if (builtinCodes.has(selector)) return selector;
  if (bareBuiltinCodes.has(selector)) return `architecture/${selector}`;
  return selector;
}

/** Validate a policy selector against built-ins and project-defined rule codes. */
export function isKnownFailOnSelector(selector: string, customCodes: ReadonlySet<string> = new Set()): boolean {
  if (selector === "all" || selector === "violations") return true;
  if (customCodes.has(selector)) return true;
  return builtinCodes.has(normalizeFailOnSelector(selector));
}

/** Return true when a finding is selected by an explicit check policy. */
export function matchesFailOn(finding: ArchitectureFinding, failOn: readonly string[]): boolean {
  if (failOn.length === 0) return false;
  if (failOn.includes("all")) return finding.category === "violation";
  if (failOn.includes("violations") && finding.category === "violation") return true;
  return failOn.some((selector) => normalizeFailOnSelector(selector) === finding.code);
}
