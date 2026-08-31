import path from "node:path";
import ts from "typescript";
import type { ImportKind, SourceImport } from "./ir.js";
import { isWithin, relativeToRoot, type DiscoveredProject } from "./project.js";
import { typeAwareImportKey, type TypeAwareImportIndex } from "./type-aware.js";

interface RawImport {
  specifier: string;
  kind: ImportKind;
  typeOnly: boolean;
  position: number;
  signature: string;
}

function sourceFileFor(file: string, text: string): ts.SourceFile {
  const scriptKind = /\.tsx$/i.test(file)
    ? ts.ScriptKind.TSX
    : /\.jsx$/i.test(file)
      ? ts.ScriptKind.JSX
      : /\.(?:mjs|cjs|js)$/i.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
}

function dynamicSpecifier(expression: ts.Expression): string {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) value += `*${span.literal.text}`;
    return value || "<dynamic>";
  }
  return "<dynamic>";
}

function collectImports(sourceFile: ts.SourceFile): RawImport[] {
  const imports: RawImport[] = [];
  const add = (specifier: string, kind: ImportKind, position: number, signature: string, typeOnly = false) => {
    imports.push({ specifier, kind, position, typeOnly, signature: signature.replace(/\s+/g, " ").trim() });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const namedBindings = clause?.namedBindings;
      const allNamedBindingsTypeOnly =
        namedBindings &&
        ts.isNamedImports(namedBindings) &&
        namedBindings.elements.length > 0 &&
        namedBindings.elements.every((element) => element.isTypeOnly);
      add(
        node.moduleSpecifier.text,
        "static",
        node.getStart(sourceFile),
        node.getText(sourceFile),
        clause?.isTypeOnly === true || allNamedBindingsTypeOnly === true,
      );
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const exportClause = node.exportClause;
      const allNamedExportsTypeOnly =
        exportClause &&
        ts.isNamedExports(exportClause) &&
        exportClause.elements.length > 0 &&
        exportClause.elements.every((element) => element.isTypeOnly);
      add(
        node.moduleSpecifier.text,
        "export",
        node.getStart(sourceFile),
        node.getText(sourceFile),
        node.isTypeOnly === true || allNamedExportsTypeOnly === true,
      );
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(dynamicSpecifier(node.arguments[0]), "dynamic", node.getStart(sourceFile), node.getText(sourceFile));
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        add(dynamicSpecifier(node.arguments[0]), "require", node.getStart(sourceFile), node.getText(sourceFile));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function isBuiltin(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    ["fs", "path", "url", "util", "events", "assert", "crypto", "stream", "os", "http", "https"].includes(specifier)
  );
}

function isLocalLike(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#");
}

function packageNameForSpecifier(specifier: string): string | undefined {
  if (isLocalLike(specifier) || specifier.startsWith("node:")) return undefined;
  const segments = specifier.split("/");
  if (segments[0]?.startsWith("@")) return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined;
  return segments[0];
}

function matchesPathPattern(specifier: string, pattern: string): boolean {
  const wildcard = pattern.indexOf("*");
  if (wildcard < 0) return specifier === pattern;
  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  return (
    specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length
  );
}

function isProjectAlias(specifier: string, compilerOptions: ts.CompilerOptions): boolean {
  const paths = compilerOptions.paths;
  return paths !== undefined && Object.keys(paths).some((pattern) => matchesPathPattern(specifier, pattern));
}

function isAssetSpecifier(specifier: string): boolean {
  const withoutQuery = specifier.split(/[?#]/, 1)[0].toLowerCase();
  return /\.(?:css|scss|sass|less|styl|pcss|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|mp4|webm|mp3|wav)$/.test(
    withoutQuery,
  );
}

function isNodeModulesPath(file: string): boolean {
  return file.split(path.sep).includes("node_modules");
}

function resolveModule(
  project: DiscoveredProject,
  specifier: string,
  containingFile: string,
  resolutionCache: ModuleResolutionCache = project.resolutionCache,
): ts.ResolvedModule | undefined {
  const cacheKey = `${containingFile}\0${specifier}`;
  if (resolutionCache.has(cacheKey)) return resolutionCache.get(cacheKey);
  const compilerOptions = project.compilerOptionsByFile.get(containingFile) ?? project.compilerOptions;
  const resolved = ts.resolveModuleName(specifier, containingFile, compilerOptions, ts.sys).resolvedModule;
  resolutionCache.set(cacheKey, resolved);
  return resolved;
}

/** Parsed source files can be shared by repeated analyses in an AnalyzerSession. */
export type SourceAstCache = Map<string, ts.SourceFile>;
/** Module resolution results are mutable analysis state, not project facts. */
export type ModuleResolutionCache = Map<string, ts.ResolvedModule | undefined>;

export function collectEdges(
  project: DiscoveredProject,
  typeAware?: TypeAwareImportIndex,
  sourceAstCache?: SourceAstCache,
  resolutionCache?: ModuleResolutionCache,
): SourceImport[] {
  const projectFiles = new Set(project.files.map((file) => path.normalize(file)));
  const edges: SourceImport[] = [];

  for (const file of project.files) {
    const text = project.fileContents.get(file) ?? "";
    const sourceFile = sourceAstCache?.get(file) ?? sourceFileFor(file, text);
    sourceAstCache?.set(file, sourceFile);
    const imports = collectImports(sourceFile);
    const occurrences = new Map<string, number>();
    for (const current of imports) {
      const resolved = resolveModule(project, current.specifier, file, resolutionCache);
      const resolvedFile = resolved ? path.normalize(resolved.resolvedFileName) : undefined;
      const internal = resolvedFile !== undefined && projectFiles.has(resolvedFile);
      const compilerOptions = project.compilerOptionsByFile.get(file) ?? project.compilerOptions;
      const projectAlias = isProjectAlias(current.specifier, compilerOptions);
      const packageName = packageNameForSpecifier(current.specifier);
      const projectLike =
        isLocalLike(current.specifier) ||
        projectAlias ||
        (packageName !== undefined && project.projectPackageNames.has(packageName));
      const declaredExternal = packageName !== undefined && project.externalPackageNames.has(packageName);
      const asset =
        isAssetSpecifier(current.specifier) || (resolvedFile !== undefined && isAssetSpecifier(resolvedFile));
      const outOfScope =
        resolvedFile !== undefined &&
        !internal &&
        isWithin(project.root, resolvedFile) &&
        !isNodeModulesPath(resolvedFile);
      const unresolvedLike = current.kind === "dynamic" || current.kind === "require" || projectLike;
      const resolution = internal
        ? "internal"
        : asset
          ? "asset"
          : outOfScope
            ? "out-of-scope"
            : resolvedFile || isBuiltin(current.specifier) || declaredExternal
              ? "external"
              : unresolvedLike
                ? "unresolved"
                : "external";
      const resolutionConfidence =
        resolvedFile !== undefined || isBuiltin(current.specifier)
          ? "exact"
          : unresolvedLike
            ? "ambiguous"
            : "syntactic";
      const location = sourceFile.getLineAndCharacterOfPosition(current.position);
      const fromFile = relativeToRoot(project.root, file);
      const toFile = internal || outOfScope ? relativeToRoot(project.root, resolvedFile!) : undefined;
      const occurrenceKey = [
        fromFile,
        current.kind,
        current.specifier,
        current.typeOnly ? "type" : "value",
        current.signature,
      ].join("\0");
      const occurrence = occurrences.get(occurrenceKey) ?? 0;
      occurrences.set(occurrenceKey, occurrence + 1);
      const semantic = typeAware?.get(typeAwareImportKey(file, current.position));
      edges.push({
        id: `${occurrenceKey}\0${occurrence}`,
        fromFile,
        ...(toFile ? { toFile } : {}),
        specifier: current.specifier,
        importKind: current.kind,
        purpose: path.basename(file).toLowerCase() === "module.arch.ts" ? "architecture-declaration" : "implementation",
        resolution,
        resolutionConfidence,
        ...(projectAlias ? { isProjectAlias: true } : {}),
        ...(projectLike ? { isProjectLike: true } : {}),
        typeOnly: current.typeOnly,
        ...(semantic ? { symbols: semantic.symbols } : {}),
        location: { line: location.line + 1, column: location.character + 1 },
        provenance: {
          origin: "observed",
          analyzer: "typescript-import-resolver",
          evidence: [{ kind: "file", id: fromFile, file: fromFile, line: location.line + 1 }],
        },
      });
    }
  }

  return edges.sort((a, b) => a.id.localeCompare(b.id));
}
