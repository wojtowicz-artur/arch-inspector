import fs from "node:fs";
import path from "node:path";
import type { ArchitectureModule } from "./ir.js";
import { isWithin, relativeToRoot, resolveConfiguredModuleRoots, type DiscoveredProject } from "./project.js";

interface ModuleAssignment {
  id: string;
  root: string;
}

interface ExplicitModule {
  id: string;
  root: string;
  publicEntrypoints?: string[];
}

function childName(root: string, file: string): string | undefined {
  const relative = path.relative(root, file);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || relative === "") return undefined;
  return relative.split(path.sep)[0];
}

function candidateId(moduleRoot: string, file: string): { id: string; root: string } {
  const child = childName(moduleRoot, file);
  if (child && !/\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/i.test(child)) {
    return { id: child, root: path.join(moduleRoot, child) };
  }
  return { id: path.basename(moduleRoot), root: moduleRoot };
}

function outsideSourceRootCandidate(project: DiscoveredProject, file: string): { id: string; root: string } {
  const relative = path.relative(project.root, file);
  const first = relative.split(path.sep)[0];
  if (!first || /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/i.test(first)) return { id: "root", root: project.root };
  return { id: first, root: path.join(project.root, first) };
}

export function inferModules(project: DiscoveredProject): {
  modules: ArchitectureModule[];
  fileToModule: Map<string, string>;
  moduleRoots: Map<string, string>;
} {
  const configuredRoots = resolveConfiguredModuleRoots(project);
  const explicitModules: ExplicitModule[] = Object.entries(project.config.modules ?? {})
    .map(([id, declaration]) => ({
      id,
      root: path.normalize(path.resolve(project.root, declaration.root)),
      ...(declaration.publicEntrypoints ? { publicEntrypoints: declaration.publicEntrypoints } : {}),
    }))
    .sort((a, b) => b.root.length - a.root.length);
  const assignments = new Map<string, ModuleAssignment>();
  const moduleRoots = new Map<string, string>();

  for (const file of project.files) {
    const explicit = explicitModules.find((module) => isWithin(module.root, file));
    const matchingRoots = configuredRoots.filter((root) => isWithin(root, file)).sort((a, b) => b.length - a.length);
    const selectedRoot = matchingRoots[0] ?? project.sourceRoot;
    const candidate = explicit
      ? { id: explicit.id, root: explicit.root }
      : matchingRoots.length === 0 && !isWithin(project.sourceRoot, file)
        ? outsideSourceRootCandidate(project, file)
        : candidateId(selectedRoot, file);
    const assignment = assignments.get(candidate.id) ?? candidate;
    assignments.set(candidate.id, assignment);
    moduleRoots.set(candidate.id, assignment.root);
  }

  const fileToModule = new Map<string, string>();
  for (const file of project.files) {
    const matching = [...assignments.values()]
      .filter((assignment) => isWithin(assignment.root, file))
      .sort((a, b) => b.root.length - a.root.length)[0];
    if (matching) fileToModule.set(file, matching.id);
    else fileToModule.set(file, path.basename(project.sourceRoot));
  }

  for (const file of project.files) {
    const moduleId = fileToModule.get(file)!;
    if (!moduleRoots.has(moduleId)) moduleRoots.set(moduleId, path.dirname(file));
  }

  const modules: ArchitectureModule[] = [...moduleRoots.entries()].map(([id, root]) => {
    const files = project.files.filter((file) => fileToModule.get(file) === id);
    const inferredEntrypoints = files
      .filter((file) => path.basename(file).replace(/\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/i, "") === "index")
      .map((file) => relativeToRoot(project.root, file))
      .sort();
    const configuredEntrypoints = (
      explicitModules.find((module) => module.id === id)?.publicEntrypoints ?? project.config.publicEntrypoints?.[id]
    )
      ?.map((file) => relativeToRoot(project.root, path.resolve(project.root, file)))
      .filter((file) => files.some((candidate) => relativeToRoot(project.root, candidate) === file))
      .sort();
    return {
      id,
      kind: "inferred",
      root: relativeToRoot(project.root, root),
      files: files.map((file) => relativeToRoot(project.root, file)).sort(),
      entrypoints: configuredEntrypoints ?? inferredEntrypoints,
      provenance: { origin: explicitModules.some((module) => module.id === id) ? "config" : "inferred" },
    };
  });

  // A module with one file in a root can still have its root inferred from that file.
  for (const module of modules) {
    if (module.root === "." && !fs.existsSync(path.join(project.root, module.root))) {
      module.root = relativeToRoot(project.root, path.dirname(project.files[0]));
    }
  }

  modules.sort((a, b) => a.id.localeCompare(b.id));
  return { modules, fileToModule, moduleRoots };
}
