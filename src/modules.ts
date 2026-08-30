import fs from "node:fs";
import path from "node:path";
import type { ModuleIdStrategy } from "./config-schema.js";
import type { ArchitectureModule } from "./ir.js";
import { isWithin, relativeToRoot, resolveConfiguredModuleRoots, type DiscoveredProject } from "./project.js";

interface ModuleCandidate {
  baseId: string;
  root: string;
  declared: boolean;
  publicEntrypoints?: string[];
}

interface CandidateRoot {
  baseId: string;
  root: string;
}

interface ExplicitModule {
  id: string;
  root: string;
  publicEntrypoints?: string[];
}

const SOURCE_EXTENSIONS = /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/i;

function isIndexFile(file: string): boolean {
  return path.basename(file).replace(SOURCE_EXTENSIONS, "") === "index";
}

function isDirectEntrypoint(moduleRoot: string, file: string): boolean {
  const relative = path.relative(moduleRoot, file);
  return !relative.startsWith(`..${path.sep}`) && relative !== ".." && relative.split(path.sep).length === 1;
}

function validateConfiguredEntrypoints(
  project: DiscoveredProject,
  moduleId: string,
  moduleRoot: string,
  files: string[],
  values: string[] | undefined,
): string[] | undefined {
  if (values === undefined) return undefined;
  const projectFiles = new Set(files.map((file) => path.normalize(file)));
  const seen = new Set<string>();
  return values.map((value) => {
    const absolute = path.normalize(path.resolve(project.root, value));
    const relative = relativeToRoot(project.root, absolute);
    if (!isWithin(moduleRoot, absolute)) {
      throw new Error(`Public entrypoint '${relative}' for module '${moduleId}' is outside its module root.`);
    }
    if (!projectFiles.has(absolute)) {
      throw new Error(`Public entrypoint '${relative}' for module '${moduleId}' is not in the analysis scope.`);
    }
    if (seen.has(relative)) throw new Error(`Duplicate public entrypoint '${relative}' for module '${moduleId}'.`);
    seen.add(relative);
    return relative;
  });
}

function childName(root: string, file: string): string | undefined {
  const relative = path.relative(root, file);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || relative === "") return undefined;
  return relative.split(path.sep)[0];
}

function candidateRoot(moduleRoot: string, file: string): CandidateRoot {
  const child = childName(moduleRoot, file);
  if (child && !/\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/i.test(child)) {
    return { baseId: child, root: path.join(moduleRoot, child) };
  }
  return { baseId: path.basename(moduleRoot), root: moduleRoot };
}

function outsideSourceRootCandidate(project: DiscoveredProject, file: string): CandidateRoot {
  const relative = path.relative(project.root, file);
  const first = relative.split(path.sep)[0];
  if (!first || /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/i.test(first)) return { baseId: "root", root: project.root };
  return { baseId: first, root: path.join(project.root, first) };
}

function relativeModulePath(project: DiscoveredProject, root: string): string {
  const relativeToSource = relativeToRoot(project.sourceRoot, root);
  if (relativeToSource !== "." && !relativeToSource.startsWith("../")) return relativeToSource;
  const relativeToProject = relativeToRoot(project.root, root);
  return relativeToProject === "." ? "root" : relativeToProject;
}

function uniqueId(preferred: string, fallback: string, used: Set<string>): string {
  if (!used.has(preferred)) return preferred;
  if (!used.has(fallback)) return fallback;
  let suffix = 2;
  while (used.has(`${fallback}#${suffix}`)) suffix += 1;
  return `${fallback}#${suffix}`;
}

function assignModuleIds(
  project: DiscoveredProject,
  candidates: ModuleCandidate[],
  strategy: ModuleIdStrategy,
): Map<string, string> {
  const inferredByBaseId = new Map<string, number>();
  for (const candidate of candidates) {
    if (!candidate.declared) inferredByBaseId.set(candidate.baseId, (inferredByBaseId.get(candidate.baseId) ?? 0) + 1);
  }

  const assigned = new Map<string, string>();
  const used = new Set<string>();
  const ordered = [...candidates].sort(
    (left, right) =>
      Number(right.declared) - Number(left.declared) ||
      left.root.localeCompare(right.root) ||
      left.baseId.localeCompare(right.baseId),
  );

  for (const candidate of ordered) {
    const fallback = relativeModulePath(project, candidate.root);
    const preferred = candidate.declared
      ? candidate.baseId
      : strategy === "relative-path" || (inferredByBaseId.get(candidate.baseId) ?? 0) > 1
        ? fallback
        : candidate.baseId;
    const id = uniqueId(preferred, fallback, used);
    assigned.set(candidate.root, id);
    used.add(id);
  }
  return assigned;
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
    .sort((a, b) => b.root.length - a.root.length || a.id.localeCompare(b.id));
  for (const module of explicitModules) {
    if (!fs.existsSync(module.root) || !fs.statSync(module.root).isDirectory()) {
      throw new Error(
        `Configured module '${module.id}' root does not exist or is not a directory: ${relativeToRoot(project.root, module.root)}`,
      );
    }
    if (!project.files.some((file) => isWithin(module.root, file))) {
      throw new Error(`Configured module '${module.id}' has no files in the analysis scope.`);
    }
  }
  const candidatesByRoot = new Map<string, ModuleCandidate>();

  for (const file of project.files) {
    const explicit = explicitModules.find((module) => isWithin(module.root, file));
    const matchingRoots = configuredRoots.filter((root) => isWithin(root, file)).sort((a, b) => b.length - a.length);
    const selectedRoot = matchingRoots[0] ?? project.sourceRoot;
    const candidate = explicit
      ? { baseId: explicit.id, root: explicit.root }
      : matchingRoots.length === 0 && !isWithin(project.sourceRoot, file)
        ? outsideSourceRootCandidate(project, file)
        : candidateRoot(selectedRoot, file);
    const root = path.normalize(candidate.root);
    const current = candidatesByRoot.get(root);
    if (!current || (explicit && !current.declared)) {
      candidatesByRoot.set(root, {
        baseId: candidate.baseId,
        root,
        declared: Boolean(explicit),
        ...(explicit?.publicEntrypoints ? { publicEntrypoints: explicit.publicEntrypoints } : {}),
      });
    }
  }

  const candidates = [...candidatesByRoot.values()].sort((a, b) => a.root.localeCompare(b.root));
  const rootToId = assignModuleIds(project, candidates, project.config.moduleIdStrategy ?? "compact");
  const assignments = candidates.map((candidate) => ({ ...candidate, id: rootToId.get(candidate.root)! }));
  const moduleRoots = new Map(assignments.map((assignment) => [assignment.id, assignment.root]));

  const fileToModule = new Map<string, string>();
  for (const file of project.files) {
    const matching = assignments
      .filter((assignment) => isWithin(assignment.root, file))
      .sort((a, b) => b.root.length - a.root.length || a.id.localeCompare(b.id))[0];
    if (matching) fileToModule.set(file, matching.id);
    else fileToModule.set(file, path.basename(project.sourceRoot));
  }

  for (const file of project.files) {
    const moduleId = fileToModule.get(file)!;
    if (!moduleRoots.has(moduleId)) moduleRoots.set(moduleId, path.dirname(file));
  }

  const modules: ArchitectureModule[] = [...moduleRoots.entries()].map(([id, root]) => {
    const files = project.files.filter((file) => fileToModule.get(file) === id);
    const assignment = assignments.find((candidate) => candidate.id === id);
    const inferredEntrypoints = files
      // Only the barrel directly under the module root is public by
      // convention. `internal/index.ts` is an implementation detail unless
      // it is explicitly listed in arch.config.json.
      .filter((file) => isIndexFile(file) && isDirectEntrypoint(root, path.normalize(path.resolve(project.root, file))))
      .map((file) => relativeToRoot(project.root, file))
      .sort();
    const configuredEntrypoints = validateConfiguredEntrypoints(
      project,
      id,
      path.normalize(path.resolve(project.root, root)),
      files.map((file) => path.normalize(path.resolve(project.root, file))),
      assignment?.publicEntrypoints ?? project.config.publicEntrypoints?.[id],
    )?.sort();
    return {
      id,
      // `id` remains the human-facing/policy name. `stableId` is derived only
      // from the physical root and therefore cannot change when another module
      // reuses the same name.
      stableId: relativeToRoot(project.root, root),
      root: relativeToRoot(project.root, root),
      files: files.map((file) => relativeToRoot(project.root, file)).sort(),
      entrypoints: configuredEntrypoints ?? inferredEntrypoints,
      provenance: {
        origin: assignment?.declared ? "declared" : "inferred",
        analyzer: "module-inference",
        ...(assignment?.declared
          ? { evidence: [{ kind: "config" as const, id: `module:${id}` }] }
          : {
              evidence: files.map((file) => ({
                kind: "file" as const,
                id: relativeToRoot(project.root, file),
                file: relativeToRoot(project.root, file),
              })),
            }),
      },
    };
  });

  const assignmentIds = new Set(assignments.map((assignment) => assignment.id));
  for (const [id, values] of Object.entries(project.config.publicEntrypoints ?? {})) {
    if (!assignmentIds.has(id)) throw new Error(`Public entrypoints refer to unknown module '${id}'.`);
    // Validate map entries even when the module projection above has no
    // matching configured declaration; otherwise a typo would silently remove
    // the requested public API.
    const assignment = assignments.find((candidate) => candidate.id === id)!;
    const files = project.files.filter((file) => fileToModule.get(file) === id);
    validateConfiguredEntrypoints(project, id, assignment.root, files, values);
  }

  const moduleIds = new Set(modules.map((module) => module.id));
  for (const dependency of project.config.forbiddenDependencies ?? []) {
    if (!moduleIds.has(dependency.from)) {
      throw new Error(`Forbidden dependency refers to unknown source module '${dependency.from}'.`);
    }
    if (!moduleIds.has(dependency.to)) {
      throw new Error(`Forbidden dependency refers to unknown target module '${dependency.to}'.`);
    }
  }

  // A module with one file in a root can still have its root inferred from that file.
  for (const module of modules) {
    if (module.root === "." && !fs.existsSync(path.join(project.root, module.root))) {
      module.root = relativeToRoot(project.root, path.dirname(project.files[0]));
    }
  }

  modules.sort((a, b) => a.id.localeCompare(b.id));
  return { modules, fileToModule, moduleRoots };
}
