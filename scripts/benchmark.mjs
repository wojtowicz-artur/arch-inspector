#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createAnalyzerSession } from "../dist/src/analyzer.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusRoot = path.join(repositoryRoot, "benchmark", "corpus");
const manifestPath = path.join(corpusRoot, "manifest.json");

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer.`);
  return parsed;
}

function parseArgs(args) {
  const options = { iterations: 5, warmup: 1, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--iterations" || argument === "-n") {
      options.iterations = positiveInteger(args[++index], argument);
    } else if (argument.startsWith("--iterations=")) {
      options.iterations = positiveInteger(argument.slice("--iterations=".length), "--iterations");
    } else if (argument === "--warmup") {
      options.warmup = positiveInteger(args[++index], argument);
    } else if (argument.startsWith("--warmup=")) {
      options.warmup = positiveInteger(argument.slice("--warmup=".length), "--warmup");
    } else if (argument === "--help" || argument === "-h") {
      console.log("Usage: npm run benchmark -- [--iterations <n>] [--warmup <n>] [--json]");
      process.exit(0);
    } else {
      throw new Error(`Unknown benchmark option '${argument}'.`);
    }
  }
  return options;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

function assertCorpusInvariants(entry, snapshot) {
  const metrics = snapshot.analysis.metrics;
  const checks = [
    ["source files", metrics.sourceFiles, entry.minSourceFiles],
    ["imports", metrics.imports, entry.minImports],
    ["modules", metrics.modules, entry.minModules],
  ];
  for (const [label, actual, minimum] of checks) {
    if (minimum !== undefined && actual < minimum) {
      throw new Error(`${entry.name}: expected at least ${minimum} ${label}, got ${actual}.`);
    }
  }
  const semanticEdges = snapshot.source.imports.filter((edge) => (edge.symbols?.length ?? 0) > 0).length;
  if ((entry.minSemanticEdges ?? 0) > semanticEdges) {
    throw new Error(`${entry.name}: expected at least ${entry.minSemanticEdges} semantic edges, got ${semanticEdges}.`);
  }
  for (const code of entry.requiredFindings ?? []) {
    if (!snapshot.analysis.findings.some((finding) => finding.code === code)) {
      throw new Error(`${entry.name}: required finding '${code}' is missing.`);
    }
  }
  if (entry.typeAware && semanticEdges === 0) throw new Error(`${entry.name}: type-aware metadata is missing.`);
  if (!entry.typeAware && semanticEdges > 0) throw new Error(`${entry.name}: unexpected type-aware metadata.`);
}

function runCase(entry, options) {
  const projectPath = path.join(corpusRoot, entry.path);
  if (!fs.existsSync(path.join(projectPath, "tsconfig.json"))) {
    throw new Error(`${entry.name}: missing tsconfig.json.`);
  }
  const session = createAnalyzerSession();
  const coldStart = performance.now();
  let reference = session.analyze(projectPath);
  const coldMs = performance.now() - coldStart;
  assertCorpusInvariants(entry, reference);
  for (let index = 0; index < options.warmup; index += 1) reference = session.analyze(projectPath);
  const durations = [];
  for (let index = 0; index < options.iterations; index += 1) {
    const start = performance.now();
    const snapshot = session.analyze(projectPath);
    durations.push(performance.now() - start);
    assertCorpusInvariants(entry, snapshot);
    if (reference && JSON.stringify(reference) !== JSON.stringify(snapshot)) {
      throw new Error(`${entry.name}: snapshot is not deterministic between benchmark runs.`);
    }
    reference = snapshot;
  }
  const metrics = reference.analysis.metrics;
  return {
    name: entry.name,
    comparison: entry.comparison,
    typeAware: entry.typeAware === true,
    iterations: options.iterations,
    sourceFiles: metrics.sourceFiles,
    imports: metrics.imports,
    modules: metrics.modules,
    semanticEdges: reference.source.imports.filter((edge) => (edge.symbols?.length ?? 0) > 0).length,
    findings: reference.analysis.findings.length,
    snapshotId: reference.receipt.snapshotId,
    coldMs: Number(coldMs.toFixed(3)),
    medianMs: Number(median(durations).toFixed(3)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
  };
}

function renderText(result, options) {
  const lines = ["Architecture benchmark", `Iterations: ${options.iterations}; warmup: ${options.warmup}`, ""];
  for (const entry of result.cases) {
    lines.push(
      `${entry.name}: ${entry.sourceFiles} files, ${entry.imports} imports, ${entry.modules} modules` +
        `, ${entry.coldMs} ms cold, ${entry.medianMs} ms warm median, ${entry.p95Ms} ms warm p95` +
        (entry.typeAware ? " [type-aware]" : ""),
    );
  }
  for (const comparison of result.comparisons) {
    lines.push(
      `type-aware overhead (${comparison.group}): ${comparison.baseline} → ${comparison.typeAware}` +
        ` ms warm median (${comparison.deltaMs} ms, ${comparison.ratio}x); cold ${comparison.coldBaseline} → ${comparison.coldTypeAware}` +
        ` ms (${comparison.coldDeltaMs} ms, ${comparison.coldRatio}x)`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest) || manifest.length === 0) throw new Error("Benchmark manifest must contain cases.");
  const cases = manifest.map((entry) => runCase(entry, options));
  const comparisons = [...new Set(manifest.map((entry) => entry.comparison).filter(Boolean))].flatMap((group) => {
    const baseline = cases.find((entry) => entry.comparison === group && !entry.typeAware);
    const typeAware = cases.find((entry) => entry.comparison === group && entry.typeAware);
    if (!baseline || !typeAware) return [];
    const deltaMs = Number((typeAware.medianMs - baseline.medianMs).toFixed(3));
    const coldDeltaMs = Number((typeAware.coldMs - baseline.coldMs).toFixed(3));
    return [
      {
        group,
        baseline: baseline.medianMs,
        typeAware: typeAware.medianMs,
        deltaMs,
        ratio: baseline.medianMs === 0 ? null : Number((typeAware.medianMs / baseline.medianMs).toFixed(3)),
        coldBaseline: baseline.coldMs,
        coldTypeAware: typeAware.coldMs,
        coldDeltaMs,
        coldRatio: baseline.coldMs === 0 ? null : Number((typeAware.coldMs / baseline.coldMs).toFixed(3)),
      },
    ];
  });
  const result = { iterations: options.iterations, warmup: options.warmup, cases, comparisons };
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : renderText(result, options));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
