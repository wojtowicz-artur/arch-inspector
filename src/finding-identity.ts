import type { ArchitectureFinding } from "./ir.js";
import { canonicalStringify, compare } from "./stable.js";

/**
 * Build a semantic finding identity for snapshot diffs and SARIF fingerprints.
 * Location and rendered text are intentionally excluded so line movement or a
 * clearer display message is reported as a change, not a new violation.
 */
export function findingKey(finding: ArchitectureFinding): string {
  const derivedFrom = [...(finding.provenance.derivedFrom ?? [])].sort(compare);
  const evidence = [...(finding.provenance.evidence ?? [])].map((item) => `${item.kind}:${item.id}`).sort(compare);
  const semanticData = Object.fromEntries(
    Object.entries(finding.data ?? {})
      .filter(
        ([key]) =>
          !/(?:message|description)$/i.test(key) &&
          !(finding.code === "architecture/cycle" && ["modules", "edgeIds"].includes(key)),
      )
      .sort(([left], [right]) => compare(left, right)),
  );
  // Provenance anchors the finding to its source fact, while semantic data
  // disambiguates multiple findings derived from that same fact. File and
  // related values are included as semantic coordinates; line and message
  // remain presentation details and are intentionally omitted.
  const identity = {
    derivedFrom: derivedFrom.length > 0 ? derivedFrom : undefined,
    evidence: evidence.length > 0 ? evidence : undefined,
    file: finding.file,
    related: finding.code === "architecture/cycle" ? undefined : finding.related,
    data: semanticData,
  };
  return [finding.code, finding.category, canonicalStringify(identity)].join("\0");
}
