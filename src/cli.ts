#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { analyzeProject } from "./analyzer.js";
import { diffSnapshots, loadSnapshot, type ArchitectureDiff } from "./diff.js";
import { analyzeGitRef } from "./git.js";
import { renderModuleGraphDot } from "./graph.js";
import type { ArchitectureSnapshot, ArchitectureDiagnostic, ArchitectureEdge } from "./ir.js";

function usage(): string {
  return `Usage:
  arch inspect [project] [--json] [--out <file>]
  arch graph [project] [--json] [--out <file>]  # Graphviz DOT by default
  arch check [project] [--json] [--out <file>]
  arch diff <git-ref|snapshot.json> [project] [--json] [--out <file>] [--check]

The inspector reads an existing TypeScript project and emits a deterministic Architecture IR snapshot.
The diff command compares the current project with a snapshot or a Git ref without changing the worktree.`;
}

interface ParsedArgs {
  command: string;
  project: string;
  json: boolean;
  check: boolean;
  base?: string;
  out?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const command = args[0] ?? "inspect";
  if (!["inspect", "graph", "check", "diff", "help", "--help", "-h"].includes(command)) throw new Error(`Unknown command '${command}'.\n\n${usage()}`);
  const positional: string[] = [];
  let out: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--out" || argument === "-o") {
      out = args[index + 1];
      index += 1;
    } else if (!argument.startsWith("--")) {
      positional.push(argument);
    }
  }
  if (command === "diff") {
    return {
      command,
      base: positional[0] ?? "HEAD",
      project: positional[1] ?? ".",
      json: args.includes("--json"),
      check: args.includes("--check"),
      ...(out ? { out } : {}),
    };
  }
  return { command, project: positional[0] ?? ".", json: args.includes("--json"), check: false, ...(out ? { out } : {}) };
}

function renderText(snapshot: ArchitectureSnapshot): string {
  const lines = [
    "Architecture inspection",
    `Project: ${snapshot.project.root}`,
    `Files: ${snapshot.metrics.sourceFiles}`,
    `Modules: ${snapshot.metrics.modules}`,
    `Imports: ${snapshot.metrics.imports} (${snapshot.metrics.internalImports} internal, ${snapshot.metrics.externalImports} external, ${snapshot.metrics.assetImports} assets, ${snapshot.metrics.unresolvedImports} unresolved)`,
    `Module edges: ${snapshot.metrics.moduleEdges}`,
    `Cycles: ${snapshot.metrics.cycles}`,
    `Deep imports: ${snapshot.metrics.deepImports}`,
    `Max fan-in: ${snapshot.metrics.maxFanIn ? `${snapshot.metrics.maxFanIn.module} (${snapshot.metrics.maxFanIn.value})` : "-"}`,
    `Max fan-out: ${snapshot.metrics.maxFanOut ? `${snapshot.metrics.maxFanOut.module} (${snapshot.metrics.maxFanOut.value})` : "-"}`,
  ];
  if (snapshot.diagnostics.length > 0) {
    lines.push("", "Diagnostics:");
    for (const diagnostic of snapshot.diagnostics) {
      const location = diagnostic.file ? ` (${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""})` : "";
      lines.push(`- [${diagnostic.level}] ${diagnostic.code}: ${diagnostic.message}${location}`);
    }
  }
  return lines.join("\n");
}

function shortEdge(edge: ArchitectureEdge): string {
  return `${edge.fromModule} → ${edge.toModule ?? edge.specifier}${edge.toFile ? ` (${edge.toFile})` : ""}`;
}

function shortDiagnostic(diagnostic: ArchitectureDiagnostic): string {
  const location = diagnostic.file ? ` (${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""})` : "";
  return `[${diagnostic.level}] ${diagnostic.code}: ${diagnostic.message}${location}`;
}

function renderDiff(diff: ArchitectureDiff): string {
  const lines = [`Architecture diff: ${diff.base} → ${diff.current}`];
  const section = (title: string, added: string[], removed: string[], changed: string[] = []): void => {
    if (added.length === 0 && removed.length === 0 && changed.length === 0) return;
    lines.push("", `${title}:`);
    for (const value of added) lines.push(`+ ${value}`);
    for (const value of removed) lines.push(`- ${value}`);
    for (const value of changed) lines.push(`~ ${value}`);
  };
  section("Modules", diff.modules.added.map((module) => module.id), diff.modules.removed.map((module) => module.id), diff.modules.changed.map(({ after }) => `${after.id} changed`));
  section("Files", diff.files.added.map((file) => `${file.path} [${file.moduleId}]`), diff.files.removed.map((file) => `${file.path} [${file.moduleId}]`), diff.files.changed.map(({ after }) => `${after.path} changed`));
  section("Module edges", diff.moduleEdges.added.map((edge) => `${edge.from} → ${edge.to}`), diff.moduleEdges.removed.map((edge) => `${edge.from} → ${edge.to}`), diff.moduleEdges.changed.map(({ after }) => `${after.from} → ${after.to} changed`));
  section("Import edges", diff.edges.added.map(shortEdge), diff.edges.removed.map(shortEdge), diff.edges.changed.map(({ after }) => `${shortEdge(after)} changed`));
  section("Cycles", diff.cycles.added.map((cycle) => `${cycle.join(" → ")} → ${cycle[0]}`), diff.cycles.removed.map((cycle) => `${cycle.join(" → ")} → ${cycle[0]}`));
  section("Diagnostics", diff.diagnostics.added.map(shortDiagnostic), diff.diagnostics.removed.map(shortDiagnostic), diff.diagnostics.changed.map(({ after }) => `${shortDiagnostic(after)} changed`));

  const changedMetrics = Object.entries(diff.metrics).filter(([, metric]) => metric.delta !== 0);
  if (changedMetrics.length > 0) {
    lines.push("", "Metrics:");
    for (const [name, metric] of changedMetrics) lines.push(`- ${name}: ${metric.before} → ${metric.after} (${metric.delta > 0 ? "+" : ""}${metric.delta})`);
  }
  lines.push("", diff.hasRegressions ? "Result: regressions introduced" : "Result: no introduced architecture violations");
  return lines.join("\n");
}

function inspectSnapshot(project: string): ArchitectureSnapshot {
  return analyzeProject(path.resolve(project));
}

function diffProject(parsed: ParsedArgs): ArchitectureDiff {
  const projectPath = path.resolve(parsed.project);
  const current = inspectSnapshot(projectPath);
  const basePath = path.resolve(parsed.base!);
  const base = fs.existsSync(basePath) && fs.statSync(basePath).isFile()
    ? loadSnapshot(basePath)
    : analyzeGitRef(parsed.base!, projectPath);
  return diffSnapshots(base, current, { base: parsed.base, current: "working tree" });
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
    console.log(usage());
    return;
  }
  if (parsed.command === "diff") {
    const diff = diffProject(parsed);
    const output = parsed.json ? `${JSON.stringify(diff, null, 2)}\n` : `${renderDiff(diff)}\n`;
    if (parsed.out) fs.writeFileSync(path.resolve(parsed.out), JSON.stringify(diff, null, 2) + "\n", "utf8");
    process.stdout.write(output);
    if (parsed.check && diff.hasRegressions) process.exitCode = 1;
    return;
  }
  const snapshot = inspectSnapshot(parsed.project);
  const output = parsed.json
    ? `${JSON.stringify(snapshot, null, 2)}\n`
    : parsed.command === "graph"
    ? renderModuleGraphDot(snapshot)
    : `${renderText(snapshot)}\n`;
  if (parsed.out) {
    const fileContents = parsed.json || parsed.command !== "graph"
      ? JSON.stringify(snapshot, null, 2) + "\n"
      : output;
    fs.writeFileSync(path.resolve(parsed.out), fileContents, "utf8");
  }
  process.stdout.write(output);
  if (parsed.command === "check" && snapshot.diagnostics.some((diagnostic) => diagnostic.category === "violation")) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
