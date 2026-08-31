#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { analyzeProject } from "./analyzer.js";
import { diffSnapshots, loadSnapshot, SnapshotComparisonError, type ArchitectureDiff } from "./diff.js";
import { analyzeGitRef } from "./git.js";
import { isKnownFailOnSelector, matchesFailOn } from "./fail-on.js";
import { renderInteractionGraphDot, renderModuleGraphDot } from "./graph.js";
import type { ArchitectureFinding, ArchitectureSnapshot, SourceImport } from "./ir.js";
import { renderSarif } from "./sarif.js";

function usage(): string {
  return `Usage:
  arch inspect [project] [--json|--sarif] [--out <file>]
  arch graph [project] [--json] [--view module|interactions] [--out <file>]  # Graphviz DOT by default
  arch check [project] [--json|--sarif] [--out <file>] [--fail-on <selector,...>]
  arch diff <git-ref|snapshot.json> [project] [--json|--sarif] [--out <file>] [--check] [--fail-on <selector,...>]
  arch audit [git-ref|snapshot.json] [project] [--json|--sarif] [--out <file>] [--fail-on <selector,...>]

Selectors include: all, violations, built-in short aliases (cycles, declared-cycles,
undeclared-dependency, deep-imports, forbidden-dependency) or canonical finding
codes such as architecture/cycle.
Without --fail-on, check is report-only unless the project config declares failOn.
The inspector reads an existing TypeScript project and emits a deterministic Architecture IR snapshot.
The diff command compares the current project with a comparable snapshot or Git ref without changing the worktree.
The audit command is a changed-architecture gate: it compares against the base and fails on introduced violations.`;
}

interface ParsedArgs {
  command: string;
  project: string;
  json: boolean;
  sarif: boolean;
  check: boolean;
  failOn?: string[];
  base?: string;
  out?: string;
  view?: "module" | "interactions";
}

function parseFailOn(args: string[]): string[] | undefined {
  const values: string[] = [];
  let present = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--fail-on") {
      present = true;
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--fail-on requires a comma-separated selector list.");
      values.push(
        ...value
          .split(",")
          .map((selector) => selector.trim())
          .filter(Boolean),
      );
      index += 1;
    } else if (argument.startsWith("--fail-on=")) {
      present = true;
      values.push(
        ...argument
          .slice("--fail-on=".length)
          .split(",")
          .map((selector) => selector.trim())
          .filter(Boolean),
      );
    }
  }
  return present ? [...new Set(values)].sort() : undefined;
}

function parseArgs(args: string[]): ParsedArgs {
  const command = args[0] ?? "inspect";
  if (!["inspect", "graph", "check", "diff", "audit", "help", "--help", "-h"].includes(command))
    throw new Error(`Unknown command '${command}'.\n\n${usage()}`);
  const positional: string[] = [];
  let out: string | undefined;
  let view: "module" | "interactions" | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--out" || argument === "-o") {
      out = args[index + 1];
      if (!out || out.startsWith("--")) throw new Error("--out requires a file path.");
      index += 1;
    } else if (argument === "--view") {
      const value = args[index + 1];
      if (command !== "graph") throw new Error("--view is only available for the graph command.");
      if (value !== "module" && value !== "interactions") throw new Error("--view must be 'module' or 'interactions'.");
      view = value;
      index += 1;
    } else if (argument.startsWith("--view=")) {
      const value = argument.slice("--view=".length);
      if (command !== "graph") throw new Error("--view is only available for the graph command.");
      if (value !== "module" && value !== "interactions") throw new Error("--view must be 'module' or 'interactions'.");
      view = value;
    } else if (argument === "--fail-on") {
      index += 1;
    } else if (!argument.startsWith("--")) {
      positional.push(argument);
    }
  }
  const failOn = parseFailOn(args);
  if (args.includes("--json") && args.includes("--sarif")) {
    throw new Error("--json and --sarif are mutually exclusive output formats.");
  }
  const sarif = args.includes("--sarif");
  if (sarif && command === "graph") throw new Error("--sarif is not available for the graph command.");
  if (command === "diff" || command === "audit") {
    return {
      command,
      base: positional[0] ?? "HEAD",
      project: positional[1] ?? ".",
      json: args.includes("--json"),
      sarif,
      check: command === "audit" || args.includes("--check"),
      ...(failOn ? { failOn } : {}),
      ...(out ? { out } : {}),
      ...(view ? { view } : {}),
    };
  }
  return {
    command,
    project: positional[0] ?? ".",
    json: args.includes("--json"),
    sarif,
    check: false,
    ...(failOn ? { failOn } : {}),
    ...(out ? { out } : {}),
    ...(view ? { view } : {}),
  };
}

function renderText(snapshot: ArchitectureSnapshot): string {
  const { metrics } = snapshot.analysis;
  const findings = snapshot.analysis.findings;
  const lines = [
    "Architecture inspection",
    `Project: ${snapshot.project.root}`,
    `Snapshot: ${snapshot.receipt.snapshotId}`,
    `Files: ${metrics.sourceFiles}`,
    `Modules: ${metrics.modules}`,
    `Imports: ${metrics.imports} (${metrics.internalImports} internal, ${metrics.externalImports} external, ${metrics.assetImports} assets, ${metrics.unresolvedImports} unresolved, ${metrics.outOfScopeImports ?? 0} out-of-scope)`,
    `Module edges: ${metrics.moduleEdges}`,
    `Contracts: ${snapshot.architecture.contracts.length}`,
    `Declared dependencies: ${snapshot.architecture.declaredDependencies.length}`,
    `Interactions: ${snapshot.architecture.interactions.length}`,
    `Cycles: ${metrics.cycles}`,
    `Declared cycles: ${snapshot.analysis.declaredCycles.length}`,
    `Deep imports: ${metrics.deepImports}`,
    `Unknown visibility imports: ${metrics.unknownVisibilityImports ?? 0}`,
    `Max fan-in: ${metrics.maxFanIn ? `${metrics.maxFanIn.module} (${metrics.maxFanIn.value})` : "-"}`,
    `Max fan-out: ${metrics.maxFanOut ? `${metrics.maxFanOut.module} (${metrics.maxFanOut.value})` : "-"}`,
    `Policy: ${snapshot.policy.failOn.length > 0 ? snapshot.policy.failOn.join(", ") : "report-only"}`,
  ];
  if (findings.length > 0) {
    lines.push("", "Findings:");
    for (const finding of findings) lines.push(`- ${shortFinding(finding)}`);
  }
  return lines.join("\n");
}

function shortImport(edge: SourceImport): string {
  return `${edge.fromFile} → ${edge.toFile ?? edge.specifier}`;
}

function shortFinding(finding: ArchitectureFinding): string {
  const location = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : "";
  return `[${finding.level}] ${finding.code}: ${finding.message}${location}`;
}

function renderDiff(diff: ArchitectureDiff): string {
  const lines = [
    `Architecture diff: ${diff.base} → ${diff.current}`,
    `Policy: ${diff.policy.failOn.length > 0 ? diff.policy.failOn.join(", ") : "report-only"}`,
  ];
  const section = (title: string, added: string[], removed: string[], changed: string[] = []): void => {
    if (added.length === 0 && removed.length === 0 && changed.length === 0) return;
    lines.push("", `${title}:`);
    for (const value of added) lines.push(`+ ${value}`);
    for (const value of removed) lines.push(`- ${value}`);
    for (const value of changed) lines.push(`~ ${value}`);
  };
  section(
    "Modules",
    diff.architecture.modules.added.map((module) => module.id),
    diff.architecture.modules.removed.map((module) => module.id),
    diff.architecture.modules.changed.map(({ after }) => `${after.id} changed`),
  );
  section(
    "Files",
    diff.source.files.added.map((file) => file.path),
    diff.source.files.removed.map((file) => file.path),
    diff.source.files.changed.map(({ after }) => `${after.path} changed`),
  );
  section(
    "Module ownership",
    diff.architecture.ownership.added.map((entry) => `${entry.file} → ${entry.module}`),
    diff.architecture.ownership.removed.map((entry) => `${entry.file} → ${entry.module}`),
    diff.architecture.ownership.changed.map(({ after }) => `${after.file} → ${after.module} changed`),
  );
  section(
    "Module edges",
    diff.architecture.moduleEdges.added.map((edge) => `${edge.from} → ${edge.to}`),
    diff.architecture.moduleEdges.removed.map((edge) => `${edge.from} → ${edge.to}`),
    diff.architecture.moduleEdges.changed.map(({ after }) => `${after.from} → ${after.to} changed`),
  );
  section(
    "Contracts",
    diff.architecture.contracts.added.map((contract) => `${contract.module}.${contract.kind}.${contract.key}`),
    diff.architecture.contracts.removed.map((contract) => `${contract.module}.${contract.kind}.${contract.key}`),
    diff.architecture.contracts.changed.map(({ after }) => `${after.id} changed`),
  );
  section(
    "Declared dependencies",
    diff.architecture.declaredDependencies.added.map((dependency) => `${dependency.from} → ${dependency.to}`),
    diff.architecture.declaredDependencies.removed.map((dependency) => `${dependency.from} → ${dependency.to}`),
    diff.architecture.declaredDependencies.changed.map(({ after }) => `${after.from} → ${after.to} changed`),
  );
  section(
    "Interactions",
    diff.architecture.interactions.added.map(
      (interaction) => `${interaction.from} → ${interaction.to} (${interaction.kind})`,
    ),
    diff.architecture.interactions.removed.map(
      (interaction) => `${interaction.from} → ${interaction.to} (${interaction.kind})`,
    ),
    diff.architecture.interactions.changed.map(({ after }) => `${after.from} → ${after.to} changed`),
  );
  section(
    "Import edges",
    diff.source.imports.added.map(shortImport),
    diff.source.imports.removed.map(shortImport),
    diff.source.imports.changed.map(({ after }) => `${shortImport(after)} changed`),
  );
  section(
    "Cycles",
    diff.analysis.cycles.added.map((cycle) => cycle.modules.join(", ")),
    diff.analysis.cycles.removed.map((cycle) => cycle.modules.join(", ")),
  );
  section(
    "Declared cycles",
    diff.analysis.declaredCycles.added.map((cycle) => cycle.modules.join(", ")),
    diff.analysis.declaredCycles.removed.map((cycle) => cycle.modules.join(", ")),
  );
  section(
    "Dependency conformance",
    diff.analysis.dependencyConformance.added.map((entry) => `${entry.from} → ${entry.to} (${entry.status})`),
    diff.analysis.dependencyConformance.removed.map((entry) => `${entry.from} → ${entry.to} (${entry.status})`),
    diff.analysis.dependencyConformance.changed.map(({ after }) => `${after.from} → ${after.to} (${after.status})`),
  );
  section(
    "Findings",
    diff.analysis.findings.added.map(shortFinding),
    diff.analysis.findings.removed.map(shortFinding),
    diff.analysis.findings.changed.map(({ after }) => `${shortFinding(after)} changed`),
  );

  const changedMetrics = Object.entries(diff.analysis.metrics).filter(([, metric]) => metric.delta !== 0);
  if (changedMetrics.length > 0) {
    lines.push("", "Metrics:");
    for (const [name, metric] of changedMetrics)
      lines.push(`- ${name}: ${metric.before} → ${metric.after} (${metric.delta > 0 ? "+" : ""}${metric.delta})`);
  }
  lines.push("", diff.hasRegressions ? "Result: regressions introduced" : "Result: no introduced violations");
  return lines.join("\n");
}

function inspectSnapshot(project: string): ArchitectureSnapshot {
  return analyzeProject(path.resolve(project));
}

function diffProject(parsed: ParsedArgs): { diff: ArchitectureDiff; current: ArchitectureSnapshot } {
  const projectPath = path.resolve(parsed.project);
  const current = inspectSnapshot(projectPath);
  const basePath = path.resolve(parsed.base!);
  const base =
    fs.existsSync(basePath) && fs.statSync(basePath).isFile()
      ? loadSnapshot(basePath)
      : analyzeGitRef(parsed.base!, projectPath);
  return { diff: diffSnapshots(base, current, { base: parsed.base, current: "working tree" }), current };
}

function effectivePolicy(snapshot: ArchitectureSnapshot, parsed: ParsedArgs): string[] {
  if (parsed.failOn) {
    const customCodes = new Set(
      snapshot.policy.knownRuleCodes ?? snapshot.analysis.findings.map((finding) => finding.code),
    );
    const unknown = parsed.failOn.filter((selector) => !isKnownFailOnSelector(selector, customCodes));
    if (unknown.length > 0) throw new Error(`Unknown failOn selector(s): ${unknown.join(", ")}.`);
    return parsed.failOn;
  }
  return parsed.check ? ["all"] : snapshot.policy.failOn;
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
    console.log(usage());
    return;
  }
  if (parsed.command === "diff" || parsed.command === "audit") {
    const { diff, current } = diffProject(parsed);
    const failOn = effectivePolicy(current, parsed);
    const output = parsed.sarif
      ? renderSarif(parsed.command === "audit" ? diff.introducedViolations : diff.analysis.findings.added)
      : parsed.json
        ? `${JSON.stringify(diff, null, 2)}\n`
        : `${renderDiff(diff)}\n`;
    if (parsed.out) {
      const fileContents = parsed.sarif ? output : JSON.stringify(diff, null, 2) + "\n";
      fs.writeFileSync(path.resolve(parsed.out), fileContents, "utf8");
    }
    process.stdout.write(output);
    if ((parsed.check || parsed.failOn) && diff.introducedViolations.some((finding) => matchesFailOn(finding, failOn)))
      process.exitCode = 1;
    return;
  }
  const snapshot = inspectSnapshot(parsed.project);
  const failOn = parsed.command === "check" ? effectivePolicy(snapshot, parsed) : [];
  const output = parsed.sarif
    ? renderSarif(snapshot.analysis.findings)
    : parsed.json
      ? `${JSON.stringify(snapshot, null, 2)}\n`
      : parsed.command === "graph"
        ? parsed.view === "interactions"
          ? renderInteractionGraphDot(snapshot)
          : renderModuleGraphDot(snapshot)
        : `${renderText(snapshot)}\n`;
  if (parsed.out) {
    const fileContents = parsed.sarif
      ? output
      : parsed.json || parsed.command !== "graph"
        ? JSON.stringify(snapshot, null, 2) + "\n"
        : output;
    fs.writeFileSync(path.resolve(parsed.out), fileContents, "utf8");
  }
  process.stdout.write(output);
  if (parsed.command === "check") {
    if (snapshot.analysis.findings.some((finding) => matchesFailOn(finding, failOn))) process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const exitCode = error instanceof SnapshotComparisonError ? 3 : 2;
  if (process.argv.includes("--json")) {
    const errorCode =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : error instanceof SnapshotComparisonError
          ? error.code
          : "ANALYSIS_ERROR";
    const envelope = {
      error: true,
      code: errorCode,
      message,
    };
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  } else {
    console.error(message);
  }
  process.exitCode = exitCode;
}
