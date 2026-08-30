import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { inspectorConfigSchema, type InspectorConfig } from "./config-schema.js";
import { formatSchemaIssues } from "./schema-utils.js";

export type { BoundaryZone, InspectorConfig, ModuleIdStrategy } from "./config-schema.js";

export interface DiscoveredProject {
  root: string;
  tsconfigPath: string;
  sourceRoot: string;
  compilerOptions: ts.CompilerOptions;
  /** Compiler options selected for the tsconfig that owns each source file. */
  compilerOptionsByFile: ReadonlyMap<string, ts.CompilerOptions>;
  /** Compiler options for every discovered project reference, keyed by tsconfig. */
  compilerOptionsByConfig: ReadonlyMap<string, ts.CompilerOptions>;
  /** Owning tsconfig for every source file before analysis filtering. */
  tsconfigPathByFile: ReadonlyMap<string, string>;
  /** Filtered source files grouped by their owning tsconfig. */
  filesByConfig: ReadonlyMap<string, readonly string[]>;
  files: string[];
  /** Source text cache shared by extraction, metrics and receipt hashing. */
  fileContents: ReadonlyMap<string, string>;
  /** Package manifests used to distinguish project-owned and external names. */
  packageJsonContents: ReadonlyMap<string, string>;
  projectPackageNames: ReadonlySet<string>;
  externalPackageNames: ReadonlySet<string>;
  /** Module resolution cache populated lazily by the import extractor. */
  resolutionCache: Map<string, ts.ResolvedModule | undefined>;
  config: InspectorConfig;
}

function normalize(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

function findTsconfig(start: string): string {
  const initial = normalize(start);
  let directory = fs.existsSync(initial) && fs.statSync(initial).isDirectory() ? initial : path.dirname(initial);

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

function sourceRootFor(root: string, files: string[], compilerOptions: ts.CompilerOptions): string {
  const configuredRoot = compilerOptions.rootDir ? normalize(compilerOptions.rootDir) : undefined;

  // A rootDir of `.` describes the emit boundary, not the source layout. Keep
  // module discovery useful for the conventional `src/...` layout instead of
  // looking only for `<project>/modules`.
  if (configuredRoot && configuredRoot !== normalize(root)) return configuredRoot;

  const srcRoot = normalize(path.join(root, "src"));
  if (files.some((file) => isWithin(srcRoot, file))) return srcRoot;

  if (configuredRoot) return configuredRoot;
  return normalize(files.length > 0 ? commonDirectory(files) : root);
}

function readInspectorConfig(root: string): InspectorConfig {
  const configPath = path.join(root, "arch.config.json");
  if (!fs.existsSync(configPath)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`Could not read arch.config.json.${reason}`, { cause: error });
  }
  const parsed = inspectorConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid arch.config.json: ${formatSchemaIssues(parsed.error)}`);
  }
  return parsed.data;
}

function isSourceFile(file: string): boolean {
  return /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/i.test(file) && !file.endsWith(".d.ts");
}

const DEFAULT_EXCLUDES = [
  "node_modules/**",
  ".next/**",
  "dist/**",
  "build/**",
  "coverage/**",
  ".turbo/**",
  ".cache/**",
];

const PACKAGE_DISCOVERY_EXCLUDES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
]);

interface PackageFacts {
  contents: ReadonlyMap<string, string>;
  projectPackageNames: ReadonlySet<string>;
  externalPackageNames: ReadonlySet<string>;
}

function packageJsonPaths(root: string): string[] {
  const discovered: string[] = [];
  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "package.json") {
        discovered.push(path.join(directory, entry.name));
        continue;
      }
      if (entry.isDirectory() && !PACKAGE_DISCOVERY_EXCLUDES.has(entry.name)) {
        visit(path.join(directory, entry.name));
      }
    }
  };
  visit(root);
  return [...new Set(discovered.map(normalize))].sort();
}

function dependencyNames(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

function readPackageFacts(root: string): PackageFacts {
  const contents = new Map<string, string>();
  const projectPackageNames = new Set<string>();
  const externalPackageNames = new Set<string>();
  for (const file of packageJsonPaths(root)) {
    const text = ts.sys.readFile(file) ?? "";
    contents.set(file, text);
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // TypeScript can still resolve a project without a valid package
      // manifest. Keep the manifest in the receipt but preserve uncertainty.
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.name === "string" && record.name.length > 0) projectPackageNames.add(record.name);
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of dependencyNames(record[field])) externalPackageNames.add(name);
    }
  }
  for (const name of projectPackageNames) externalPackageNames.delete(name);
  return { contents, projectPackageNames, externalPackageNames };
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`);
}

function matchesGlob(relativePath: string, pattern: string): boolean {
  const normalizedPattern = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedPath = relativePath.replaceAll("\\", "/");
  const direct = globToRegExp(normalizedPattern).test(normalizedPath);
  // A directory-like pattern such as `src` is useful shorthand for `src/**`.
  if (direct || /[*?]/.test(normalizedPattern)) return direct;
  return globToRegExp(`${normalizedPattern}/**`).test(normalizedPath);
}

function filterProjectFiles(root: string, files: string[], config: InspectorConfig): string[] {
  const include = config.include?.length ? config.include : undefined;
  const exclude = [...DEFAULT_EXCLUDES, ...(config.exclude ?? [])];
  return files.filter((file) => {
    const relative = relativeToRoot(root, file);
    const included = include ? include.some((pattern) => matchesGlob(relative, pattern)) : true;
    const excluded = exclude.some((pattern) => matchesGlob(relative, pattern));
    return included && !excluded;
  });
}

export function discoverProject(inputPath = "."): DiscoveredProject {
  const tsconfigPath = findTsconfig(inputPath);
  const root = path.dirname(tsconfigPath);
  const config = readInspectorConfig(root);
  const visited = new Set<string>();
  const referencedFiles: string[] = [];
  const compilerOptionsByFile = new Map<string, ts.CompilerOptions>();
  const compilerOptionsByConfig = new Map<string, ts.CompilerOptions>();
  const tsconfigPathByFile = new Map<string, string>();
  const filesByConfig = new Map<string, string[]>();
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
    if (parsed.errors.length > 0) {
      throw new Error(
        parsed.errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"),
      );
    }
    compilerOptionsByConfig.set(normalizedConfig, parsed.options);
    const sourceFiles = parsed.fileNames.filter(isSourceFile).map(normalize);
    referencedFiles.push(...sourceFiles);
    const configFiles = filesByConfig.get(normalizedConfig) ?? [];
    configFiles.push(...sourceFiles);
    filesByConfig.set(normalizedConfig, configFiles);
    for (const file of sourceFiles) {
      // The root config wins if a referenced project accidentally includes the
      // same file as well. This keeps the owning project deterministic.
      if (!compilerOptionsByFile.has(file)) {
        compilerOptionsByFile.set(file, parsed.options);
        tsconfigPathByFile.set(file, normalizedConfig);
      }
    }
    // Keep the root project's compiler context as the project default. A
    // referenced tsconfig must not overwrite it merely because it is visited
    // later in the graph.
    if (normalizedConfig === normalize(tsconfigPath)) compilerOptions = parsed.options;
    const references = Array.isArray(read.config?.references) ? read.config.references : [];
    for (const reference of references) {
      if (!reference || typeof reference.path !== "string") continue;
      const referencePath = normalize(path.resolve(configRoot, reference.path));
      const referenceConfig =
        fs.existsSync(referencePath) && fs.statSync(referencePath).isDirectory()
          ? path.join(referencePath, "tsconfig.json")
          : fs.existsSync(referencePath) && fs.statSync(referencePath).isFile()
            ? referencePath
            : referencePath.endsWith(".json")
              ? referencePath
              : `${referencePath}.json`;
      if (!fs.existsSync(referenceConfig)) {
        throw new Error(`Referenced tsconfig does not exist: ${relativeToRoot(root, referenceConfig)}`);
      }
      readConfig(referenceConfig);
    }
  };

  readConfig(tsconfigPath);
  const files = filterProjectFiles(root, [...new Set(referencedFiles)].sort(), config);
  const includedFiles = new Set(files);
  const filteredFilesByConfig = new Map<string, readonly string[]>();
  for (const [configPath, configFiles] of filesByConfig) {
    const owned = [...new Set(configFiles)]
      .filter((file) => includedFiles.has(file) && tsconfigPathByFile.get(file) === configPath)
      .sort();
    if (owned.length > 0) filteredFilesByConfig.set(configPath, owned);
  }
  const fileContents = new Map(files.map((file) => [file, ts.sys.readFile(file) ?? ""]));
  const packageFacts = readPackageFacts(root);
  const sourceRoot = sourceRootFor(root, files, compilerOptions);

  return {
    root: normalize(root),
    tsconfigPath: normalize(tsconfigPath),
    sourceRoot,
    compilerOptions,
    compilerOptionsByFile,
    compilerOptionsByConfig,
    tsconfigPathByFile,
    filesByConfig: filteredFilesByConfig,
    files,
    fileContents,
    packageJsonContents: packageFacts.contents,
    projectPackageNames: packageFacts.projectPackageNames,
    externalPackageNames: packageFacts.externalPackageNames,
    resolutionCache: new Map(),
    config,
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
  const configured = project.config.moduleRoots?.map((root) => normalize(path.resolve(project.root, root))) ?? [];
  if (configured.length > 0) {
    for (const moduleRoot of configured) {
      if (!fs.existsSync(moduleRoot) || !fs.statSync(moduleRoot).isDirectory()) {
        throw new Error(
          `Configured module root does not exist or is not a directory: ${relativeToRoot(project.root, moduleRoot)}`,
        );
      }
    }
    return [...new Set(configured)];
  }

  // Search conventional module folders relative to both the selected source
  // root and the project root. This keeps discovery independent from an emit
  // rootDir such as `.` and still supports projects without a src directory.
  const searchRoots = [...new Set([project.sourceRoot, project.root, path.join(project.root, "src")])];
  const candidates = searchRoots.flatMap((searchRoot) =>
    ["modules", "features", "app", "shared"].map((name) => path.join(searchRoot, name)),
  );
  const existing = [...new Set(candidates)].filter(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory(),
  );
  return existing.length > 0 ? existing : [project.sourceRoot];
}
