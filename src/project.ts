import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface InspectorConfig {
  moduleRoots?: string[];
  noCycles?: boolean;
  noDeepImports?: boolean;
  forbiddenDependencies?: Array<{
    from: string;
    to: string;
    message?: string;
  }>;
}

export interface DiscoveredProject {
  root: string;
  tsconfigPath: string;
  sourceRoot: string;
  compilerOptions: ts.CompilerOptions;
  files: string[];
  config: InspectorConfig;
}

function normalize(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

function findTsconfig(start: string): string {
  const initial = normalize(start);
  let directory = fs.existsSync(initial) && fs.statSync(initial).isDirectory()
    ? initial
    : path.dirname(initial);

  while (true) {
    const candidate = path.join(directory, "tsconfig.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(`Could not find tsconfig.json from ${start}`);
}

function commonDirectory(files: string[]): string {
  if (files.length === 0) return process.cwd();
  const parts = files.map((file) => path.dirname(file).split(path.sep));
  const first = parts[0];
  let length = 0;
  while (length < first.length && parts.every((candidate) => candidate[length] === first[length])) {
    length += 1;
  }
  return first.slice(0, length).join(path.sep) || path.parse(files[0]).root;
}

function readInspectorConfig(root: string): InspectorConfig {
  const configPath = path.join(root, "arch.config.json");
  if (!fs.existsSync(configPath)) return {};
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  if (!raw || typeof raw !== "object") throw new Error("arch.config.json must contain an object");
  return raw as InspectorConfig;
}

function isSourceFile(file: string): boolean {
  return /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/i.test(file) && !file.endsWith(".d.ts");
}

export function discoverProject(inputPath = "."): DiscoveredProject {
  const tsconfigPath = findTsconfig(inputPath);
  const root = path.dirname(tsconfigPath);
  const visited = new Set<string>();
  const referencedFiles: string[] = [];
  let compilerOptions: ts.CompilerOptions = {};

  const readConfig = (configPath: string): void => {
    const normalizedConfig = normalize(configPath);
    if (visited.has(normalizedConfig)) return;
    visited.add(normalizedConfig);
    const read = ts.readConfigFile(normalizedConfig, ts.sys.readFile);
    if (read.error) {
      throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
    }
    const configRoot = path.dirname(normalizedConfig);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, configRoot, undefined, normalizedConfig);
    referencedFiles.push(...parsed.fileNames.filter(isSourceFile).map(normalize));
    compilerOptions = { ...compilerOptions, ...parsed.options };
    const references = Array.isArray(read.config?.references) ? read.config.references : [];
    for (const reference of references) {
      if (!reference || typeof reference.path !== "string") continue;
      const referencePath = normalize(path.resolve(configRoot, reference.path));
      const referenceConfig = fs.existsSync(referencePath) && fs.statSync(referencePath).isDirectory()
        ? path.join(referencePath, "tsconfig.json")
        : referencePath.endsWith(".json") ? referencePath : `${referencePath}.json`;
      if (fs.existsSync(referenceConfig)) readConfig(referenceConfig);
    }
  };

  readConfig(tsconfigPath);
  const files = [...new Set(referencedFiles)].sort();
  const sourceRoot = normalize(compilerOptions.rootDir ?? path.join(root, files.some((file) => file.includes(`${path.sep}src${path.sep}`)) ? "src" : path.relative(root, commonDirectory(files))));

  return {
    root: normalize(root),
    tsconfigPath: normalize(tsconfigPath),
    sourceRoot,
    compilerOptions,
    files,
    config: readInspectorConfig(root),
  };
}

export function relativeToRoot(root: string, file: string): string {
  const relative = path.relative(root, file);
  return (relative || ".").split(path.sep).join("/");
}

export function isWithin(parent: string, file: string): boolean {
  const relative = path.relative(parent, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function resolveConfiguredModuleRoots(project: DiscoveredProject): string[] {
  const configured = project.config.moduleRoots?.map((root) => normalize(path.join(project.root, root))) ?? [];
  if (configured.length > 0) return configured.filter((root) => fs.existsSync(root));

  const candidates = [
    path.join(project.sourceRoot, "modules"),
    path.join(project.sourceRoot, "features"),
    path.join(project.sourceRoot, "app"),
    path.join(project.sourceRoot, "shared"),
  ];
  const existing = candidates.filter((candidate) => fs.existsSync(candidate));
  return existing.length > 0 ? existing : [project.sourceRoot];
}
