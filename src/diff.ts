import fs from "node:fs";
import { IR_VERSION } from "./ir.js";
import type {
  ArchitectureCycle,
  ArchitectureFinding,
  ArchitectureModule,
  ArchitectureSnapshot,
  FileOwnership,
  ModuleEdge,
  SourceFile,
  SourceImport,
} from "./ir.js";
import { architectureSnapshotSchema } from "./ir-schema.js";
import { findingKey } from "./rules.js";
import { canonicalStringify, compare, sha256 } from "./stable.js";
import { formatSchemaIssues } from "./schema-utils.js";

export interface CollectionDiff<T> {
  added: T[];
  removed: T[];
  changed: Array<{ before: T; after: T }>;
}

export interface MetricDelta {
  before: number;
  after: number;
  delta: number;
}

export class SnapshotComparisonError extends Error {
  readonly code = "INCOMPARABLE_SNAPSHOTS" as const;

  constructor(readonly reasons: string[]) {
    super(`Snapshots are not comparable: ${reasons.join("; ")}`);
    this.name = "SnapshotComparisonError";
  }
}

export interface ArchitectureDiff {
  irVersion: ArchitectureSnapshot["irVersion"];
  base: string;
  current: string;
  policy: {
    failOn: string[];
  };
  comparability: {
    status: "comparable";
    reasons: string[];
  };
  source: {
    files: CollectionDiff<SourceFile>;
    imports: CollectionDiff<SourceImport>;
  };
  architecture: {
    modules: CollectionDiff<ArchitectureModule>;
    ownership: CollectionDiff<FileOwnership>;
    moduleEdges: CollectionDiff<ModuleEdge>;
  };
  analysis: {
    cycles: CollectionDiff<ArchitectureCycle>;
    findings: CollectionDiff<ArchitectureFinding>;
    metrics: Record<string, MetricDelta>;
  };
  introducedViolations: ArchitectureFinding[];
  resolvedViolations: ArchitectureFinding[];
  hasRegressions: boolean;
}

function diffCollection<T>(before: T[], after: T[], key: (value: T) => string): CollectionDiff<T> {
  const beforeMap = new Map(before.map((value) => [key(value), value]));
  const afterMap = new Map(after.map((value) => [key(value), value]));
  return {
    added: [...afterMap.entries()]
      .filter(([entryKey]) => !beforeMap.has(entryKey))
      .sort(([left], [right]) => compare(left, right))
      .map(([, value]) => value),
    removed: [...beforeMap.entries()]
      .filter(([entryKey]) => !afterMap.has(entryKey))
      .sort(([left], [right]) => compare(left, right))
      .map(([, value]) => value),
    changed: [...afterMap.entries()]
      .filter(
        ([entryKey, value]) =>
          beforeMap.has(entryKey) && canonicalStringify(beforeMap.get(entryKey)) !== canonicalStringify(value),
      )
      .sort(([left], [right]) => compare(left, right))
      .map(([entryKey, value]) => ({ before: beforeMap.get(entryKey)!, after: value })),
  };
}

function metricDeltas(before: ArchitectureSnapshot, after: ArchitectureSnapshot): Record<string, MetricDelta> {
  const result: Record<string, MetricDelta> = {};
  const keys = [
    "sourceFiles",
    "modules",
    "imports",
    "internalImports",
    "externalImports",
    "assetImports",
    "unresolvedImports",
    "moduleEdges",
    "cycles",
    "deepImports",
  ] as const;
  for (const key of keys) {
    const beforeValue = before.analysis.metrics[key];
    const afterValue = after.analysis.metrics[key];
    result[key] = { before: beforeValue, after: afterValue, delta: afterValue - beforeValue };
  }
  return result;
}

function comparabilityReasons(before: ArchitectureSnapshot, after: ArchitectureSnapshot): string[] {
  const reasons: string[] = [];
  if (before.irVersion !== after.irVersion) reasons.push(`IR ${before.irVersion} != ${after.irVersion}`);
  if (before.receipt.toolVersion !== after.receipt.toolVersion)
    reasons.push(`tool ${before.receipt.toolVersion} != ${after.receipt.toolVersion}`);
  if (before.receipt.configHash !== after.receipt.configHash) reasons.push("analysis configuration differs");
  if (before.receipt.compilerOptionsHash !== after.receipt.compilerOptionsHash) reasons.push("compiler options differ");
  if (before.project.tsconfig !== after.project.tsconfig) reasons.push("tsconfig path differs");
  if (before.project.sourceRoot !== after.project.sourceRoot) reasons.push("source root differs");
  return reasons;
}

export function diffSnapshots(
  before: ArchitectureSnapshot,
  after: ArchitectureSnapshot,
  labels: { base?: string; current?: string } = {},
): ArchitectureDiff {
  const reasons = comparabilityReasons(before, after);
  if (reasons.length > 0) throw new SnapshotComparisonError(reasons);

  const modules = diffCollection(before.architecture.modules, after.architecture.modules, (module) => module.id);
  const ownership = diffCollection(before.architecture.ownership, after.architecture.ownership, (entry) => entry.file);
  const files = diffCollection(before.source.files, after.source.files, (file) => file.path);
  const imports = diffCollection(before.source.imports, after.source.imports, (edge) => edge.id);
  const moduleEdges = diffCollection(
    before.architecture.moduleEdges,
    after.architecture.moduleEdges,
    (edge) => edge.id,
  );
  const cycles = diffCollection(before.analysis.cycles, after.analysis.cycles, (cycle) => cycle.id);
  const findings = diffCollection(before.analysis.findings, after.analysis.findings, findingKey);
  const introducedViolations = findings.added
    .filter((finding) => finding.category === "violation")
    .sort((a, b) => compare(findingKey(a), findingKey(b)));
  const resolvedViolations = findings.removed
    .filter((finding) => finding.category === "violation")
    .sort((a, b) => compare(findingKey(a), findingKey(b)));

  return {
    irVersion: before.irVersion,
    base: labels.base ?? "base",
    current: labels.current ?? "current",
    policy: { failOn: [...after.policy.failOn] },
    comparability: { status: "comparable", reasons: [] },
    source: { files, imports },
    architecture: { modules, ownership, moduleEdges },
    analysis: { cycles, findings, metrics: metricDeltas(before, after) },
    introducedViolations,
    resolvedViolations,
    hasRegressions: cycles.added.length > 0 || introducedViolations.length > 0,
  };
}

export function loadSnapshot(filePath: string): ArchitectureSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`Could not read architecture snapshot '${filePath}'.${reason}`, { cause: error });
  }
  const validated = architectureSnapshotSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `'${filePath}' is not an Architecture IR ${IR_VERSION} snapshot. ${formatSchemaIssues(validated.error)}`,
    );
  }
  const snapshot = validated.data;
  const { receipt, ...base } = snapshot;
  const expected = sha256({ ...base, receipt: { ...receipt, snapshotId: "" } });
  if (expected !== receipt.snapshotId) {
    throw new Error(`'${filePath}' has an invalid snapshot receipt.`);
  }
  return snapshot;
}
