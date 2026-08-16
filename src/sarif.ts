import { TOOL_VERSION, type ArchitectureFinding, type DiagnosticLevel } from "./ir.js";
import { findingKey } from "./rules.js";
import { compare, sha256 } from "./stable.js";

export interface SarifLog {
  version: "2.1.0";
  $schema: "https://json.schemastore.org/sarif-2.1.0.json";
  runs: SarifRun[];
}

interface SarifRun {
  tool: {
    driver: {
      name: "arch-inspector";
      version: typeof TOOL_VERSION;
      rules: SarifRule[];
    };
  };
  results: SarifResult[];
}

interface SarifRule {
  id: string;
  shortDescription: { text: string };
  defaultConfiguration: { level: "error" | "warning" | "note" };
}

interface SarifResult {
  ruleId: string;
  level: "error" | "warning" | "note";
  kind: "fail" | "informational";
  message: { text: string };
  locations?: SarifLocation[];
  partialFingerprints: { archInspectorFinding: string };
  properties?: Record<string, unknown>;
}

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
    region?: { startLine: number; startColumn?: number };
  };
}

function sarifLevel(level: DiagnosticLevel): "error" | "warning" | "note" {
  return level === "info" ? "note" : level;
}

function locationFor(finding: ArchitectureFinding): SarifLocation | undefined {
  if (!finding.file) return undefined;
  return {
    physicalLocation: {
      artifactLocation: { uri: finding.file },
      ...(finding.line
        ? {
            region: {
              startLine: finding.line,
              ...(finding.data?.column && typeof finding.data.column === "number"
                ? { startColumn: finding.data.column }
                : {}),
            },
          }
        : {}),
    },
  };
}

export function createSarifLog(findings: readonly ArchitectureFinding[]): SarifLog {
  const sorted = [...findings].sort((left, right) => compare(findingKey(left), findingKey(right)));
  const ruleIds = [...new Set(sorted.map((finding) => finding.code))].sort(compare);
  const rules = ruleIds.map((id) => {
    const finding = sorted.find((candidate) => candidate.code === id)!;
    return {
      id,
      shortDescription: { text: id },
      defaultConfiguration: { level: sarifLevel(finding.level) },
    } satisfies SarifRule;
  });
  const results = sorted.map((finding) => {
    const location = locationFor(finding);
    return {
      ruleId: finding.code,
      level: sarifLevel(finding.level),
      kind: finding.category === "violation" ? "fail" : "informational",
      message: { text: finding.message },
      ...(location ? { locations: [location] } : {}),
      partialFingerprints: { archInspectorFinding: sha256(findingKey(finding)) },
      ...(finding.data ? { properties: finding.data } : {}),
    } satisfies SarifResult;
  });
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "arch-inspector",
            version: TOOL_VERSION,
            rules,
          },
        },
        results,
      },
    ],
  };
}

export function renderSarif(findings: readonly ArchitectureFinding[]): string {
  return `${JSON.stringify(createSarifLog(findings), null, 2)}\n`;
}
