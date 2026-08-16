import fs from "node:fs";
import type {
  ArchitectureDiagnostic,
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
  modules: CollectionDiff<ArchitectureModule>;
  files: CollectionDiff<ArchitectureFile>;
  edges: CollectionDiff<ArchitectureEdge>;
  moduleEdges: CollectionDiff<ModuleEdge>;
  cycles: CollectionDiff<string[]>;
  diagnostics: CollectionDiff<ArchitectureDiagnostic>;
  metrics: Record<string, MetricDelta>;
  introducedViolations: ArchitectureDiagnostic[];
  resolvedViolations: ArchitectureDiagnostic[];
  hasRegressions: boolean;
}

function compare(a: string, b: string): number {
  return a.localeCompare(b);
}

function diffCollection<T>(
  before: T[],
  after: T[],
  key: (value: T) => string,
): CollectionDiff<T> {
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
      .filter(([entryKey, value]) => beforeMap.has(entryKey) && JSON.stringify(beforeMap.get(entryKey)) !== JSON.stringify(value))
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

function cycleKey(cycle: string[]): string {
  return [...cycle].sort(compare).join("\0");
}

function metricDeltas(before: ArchitectureSnapshot, after: ArchitectureSnapshot): Record<string, MetricDelta> {
  const result: Record<string, MetricDelta> = {};
  const keys = [
    "sourceFiles",
    "modules",
    "imports",
    "internalImports",
    "externalImports",
    "unresolvedImports",
    "moduleEdges",
    "cycles",
    "deepImports",
  ] as const;
  for (const key of keys) {
    const beforeValue = before.metrics[key];
    const afterValue = after.metrics[key];
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

  const modules = diffCollection(before.modules, after.modules, (module) => module.id);
  const files = diffCollection(before.files, after.files, (file) => file.path);
  const edges = diffCollection(before.edges, after.edges, edgeKey);
  const moduleEdges = diffCollection(before.moduleEdges, after.moduleEdges, (edge) => `${edge.from}\0${edge.to}`);
  const cycles = diffCollection(before.cycles, after.cycles, cycleKey);
  const diagnostics = diffCollection(before.diagnostics, after.diagnostics, diagnosticKey);
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
    modules,
    files,
    edges,
    moduleEdges,
    cycles,
    diagnostics,
    metrics: metricDeltas(before, after),
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
    throw new Error(`Could not read architecture snapshot '${filePath}'.${reason}`);
  }
  if (!parsed || typeof parsed !== "object" || (parsed as Partial<ArchitectureSnapshot>).irVersion !== "0.1") {
    throw new Error(`'${filePath}' is not an Architecture IR 0.1 snapshot.`);
  }
  return parsed as ArchitectureSnapshot;
}
