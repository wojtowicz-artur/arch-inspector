import fs from "node:fs";
import { IR_VERSION } from "./ir.js";
import type {
  ArchitectureDiagnostic,
  ArchitectureCycle,
  ArchitectureEdge,
  ArchitectureFile,
  ArchitectureModule,
  ArchitectureSnapshot,
  ModuleEdge,
} from "./ir.js";

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

export interface ArchitectureDiff {
  irVersion: ArchitectureSnapshot["irVersion"];
  base: string;
  current: string;
  source: {
    files: CollectionDiff<ArchitectureFile>;
    edges: CollectionDiff<ArchitectureEdge>;
  };
  architecture: {
    modules: CollectionDiff<ArchitectureModule>;
    moduleEdges: CollectionDiff<ModuleEdge>;
    cycles: CollectionDiff<ArchitectureCycle>;
    diagnostics: CollectionDiff<ArchitectureDiagnostic>;
    metrics: Record<string, MetricDelta>;
  };
  introducedViolations: ArchitectureDiagnostic[];
  resolvedViolations: ArchitectureDiagnostic[];
  hasRegressions: boolean;
}

function compare(a: string, b: string): number {
  return a.localeCompare(b);
}

function diffCollection<T>(before: T[], after: T[], key: (value: T) => string): CollectionDiff<T> {
  const beforeMap = new Map(before.map((value) => [key(value), value]));
  const afterMap = new Map(after.map((value) => [key(value), value]));
  return {
    added: [...afterMap.entries()]
      .filter(([entryKey]) => !beforeMap.has(entryKey))
      .sort(([a], [b]) => compare(a, b))
      .map(([, value]) => value),
    removed: [...beforeMap.entries()]
      .filter(([entryKey]) => !afterMap.has(entryKey))
      .sort(([a], [b]) => compare(a, b))
      .map(([, value]) => value),
    changed: [...afterMap.entries()]
      .filter(
        ([entryKey, value]) =>
          beforeMap.has(entryKey) && JSON.stringify(beforeMap.get(entryKey)) !== JSON.stringify(value),
      )
      .sort(([a], [b]) => compare(a, b))
      .map(([entryKey, value]) => ({ before: beforeMap.get(entryKey)!, after: value })),
  };
}

function edgeKey(edge: ArchitectureEdge): string {
  return [
    edge.fromFile,
    edge.toFile ?? "",
    edge.fromModule,
    edge.toModule ?? "",
    edge.specifier,
    edge.importKind,
    edge.resolution,
    edge.typeOnly ? "type" : "value",
    edge.publicApi ? "public" : "deep",
  ].join("\0");
}

function diagnosticKey(diagnostic: ArchitectureDiagnostic): string {
  return [diagnostic.code, diagnostic.category, diagnostic.file ?? "", diagnostic.message].join("\0");
}

function cycleKey(cycle: ArchitectureCycle): string {
  return [...cycle.modules].sort(compare).join("\0");
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
    const beforeValue = before.architecture.metrics[key];
    const afterValue = after.architecture.metrics[key];
    result[key] = { before: beforeValue, after: afterValue, delta: afterValue - beforeValue };
  }
  return result;
}

export function diffSnapshots(
  before: ArchitectureSnapshot,
  after: ArchitectureSnapshot,
  labels: { base?: string; current?: string } = {},
): ArchitectureDiff {
  if (before.irVersion !== after.irVersion) {
    throw new Error(`Cannot compare IR ${before.irVersion} with IR ${after.irVersion}.`);
  }

  const modules = diffCollection(before.architecture.modules, after.architecture.modules, (module) => module.id);
  const files = diffCollection(before.source.files, after.source.files, (file) => file.path);
  const edges = diffCollection(before.source.edges, after.source.edges, edgeKey);
  const moduleEdges = diffCollection(
    before.architecture.moduleEdges,
    after.architecture.moduleEdges,
    (edge) => `${edge.from}\0${edge.to}`,
  );
  const cycles = diffCollection(before.architecture.cycles, after.architecture.cycles, cycleKey);
  const diagnostics = diffCollection(before.architecture.diagnostics, after.architecture.diagnostics, diagnosticKey);
  const introducedViolations = diagnostics.added
    .filter((diagnostic) => diagnostic.category === "violation")
    .sort((a, b) => diagnosticKey(a).localeCompare(diagnosticKey(b)));
  const resolvedViolations = diagnostics.removed
    .filter((diagnostic) => diagnostic.category === "violation")
    .sort((a, b) => diagnosticKey(a).localeCompare(diagnosticKey(b)));

  return {
    irVersion: before.irVersion,
    base: labels.base ?? "base",
    current: labels.current ?? "current",
    source: { files, edges },
    architecture: { modules, moduleEdges, cycles, diagnostics, metrics: metricDeltas(before, after) },
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
  if (!isArchitectureSnapshot(parsed)) {
    throw new Error(`'${filePath}' is not an Architecture IR ${IR_VERSION} snapshot.`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasProvenance(value: unknown): boolean {
  if (!isRecord(value) || typeof value.origin !== "string") return false;
  return ["source", "config", "inferred", "derived"].includes(value.origin);
}

function isArchitectureSnapshot(value: unknown): value is ArchitectureSnapshot {
  if (!isRecord(value) || value.irVersion !== IR_VERSION) return false;
  const source = value.source;
  const architecture = value.architecture;
  if (!isRecord(source) || !isRecord(architecture)) return false;
  if (!hasProvenance(source.provenance) || !hasProvenance(architecture.provenance)) return false;
  if (!Array.isArray(source.files) || !Array.isArray(source.edges)) return false;
  if (
    !Array.isArray(architecture.modules) ||
    !Array.isArray(architecture.moduleEdges) ||
    !Array.isArray(architecture.cycles) ||
    !Array.isArray(architecture.diagnostics) ||
    !isRecord(architecture.metrics)
  )
    return false;
  const facts = [
    ...source.files,
    ...source.edges,
    ...architecture.modules,
    ...architecture.moduleEdges,
    ...architecture.cycles,
    ...architecture.diagnostics,
    architecture.metrics,
  ];
  return facts.every((fact) => isRecord(fact) && hasProvenance(fact.provenance));
}
