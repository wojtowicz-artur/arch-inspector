import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { inspectorConfigSchema, type InspectorConfig } from "./config-schema.js";
import { formatSchemaIssues } from "./schema-utils.js";

export type { InspectorConfig, ModuleIdStrategy } from "./config-schema.js";

export interface DiscoveredProject {
  root: string;
  tsconfigPath: string;
  sourceRoot: string;
  compilerOptions: ts.CompilerOptions;
  /** Compiler options selected for the tsconfig that owns each source file. */
  compilerOptionsByFile: ReadonlyMap<string, ts.CompilerOptions>;
  files: string[];
  /** Source text cache shared by extraction, metrics and receipt hashing. */
  fileContents: ReadonlyMap<string, string>;
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
        ts.flattenDiagnosticMessageText(parsed.errors.map((diagnostic) => diagnostic.messageText).join("\n"), "\n"),
      );
    }
    const sourceFiles = parsed.fileNames.filter(isSourceFile).map(normalize);
    referencedFiles.push(...sourceFiles);
    for (const file of sourceFiles) {
      // The root config wins if a referenced project accidentally includes the
      // same file as well. This keeps the owning project deterministic.
      if (!compilerOptionsByFile.has(file)) compilerOptionsByFile.set(file, parsed.options);
    }
    compilerOptions = { ...compilerOptions, ...parsed.options };
    const references = Array.isArray(read.config?.references) ? read.config.references : [];
    for (const reference of references) {
      if (!reference || typeof reference.path !== "string") continue;
      const referencePath = normalize(path.resolve(configRoot, reference.path));
      const referenceConfig =
        fs.existsSync(referencePath) && fs.statSync(referencePath).isDirectory()
          ? path.join(referencePath, "tsconfig.json")
          : referencePath.endsWith(".json")
            ? referencePath
            : `${referencePath}.json`;
      if (fs.existsSync(referenceConfig)) readConfig(referenceConfig);
    }
  };

  readConfig(tsconfigPath);
  const files = filterProjectFiles(root, [...new Set(referencedFiles)].sort(), config);
  const fileContents = new Map(files.map((file) => [file, ts.sys.readFile(file) ?? ""]));
  const sourceRoot = normalize(
    compilerOptions.rootDir ??
      path.join(
        root,
        files.some((file) => file.includes(`${path.sep}src${path.sep}`))
          ? "src"
          : path.relative(root, commonDirectory(files)),
      ),
  );

  return {
    root: normalize(root),
    tsconfigPath: normalize(tsconfigPath),
    sourceRoot,
    compilerOptions,
    compilerOptionsByFile,
    files,
    fileContents,
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
