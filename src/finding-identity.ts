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
  const hasStableAnchor = derivedFrom.length > 0 || evidence.length > 0;
  const semanticData = hasStableAnchor
    ? undefined
    : Object.fromEntries(
        Object.entries(finding.data ?? {})
          .filter(([key]) => !/(?:message|description)$/i.test(key))
          .sort(([left], [right]) => compare(left, right)),
      );
  // A stable provenance anchor already identifies the source fact (and, for
  // policy-generated duplicates, the synthetic rule discriminator). Display
  // coordinates such as module IDs, file paths and related labels must not
  // make that identity move when the architecture is merely renamed. Findings
  // without provenance still need their semantic payload as a fallback.
  const identity = {
    ...(derivedFrom.length > 0 ? { derivedFrom } : evidence.length > 0 ? { evidence } : {}),
    ...(hasStableAnchor
      ? {}
      : {
          file: finding.file,
          related: finding.related,
          data: semanticData,
        }),
  };
  return [finding.code, finding.category, canonicalStringify(identity)].join("\0");
}
