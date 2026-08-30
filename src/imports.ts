import path from "node:path";
import ts from "typescript";
import type { ImportKind, SourceImport } from "./ir.js";
import { relativeToRoot, type DiscoveredProject } from "./project.js";
import { typeAwareImportKey, type TypeAwareImportIndex } from "./type-aware.js";

interface RawImport {
  specifier: string;
  kind: ImportKind;
  typeOnly: boolean;
  position: number;
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
  const add = (specifier: string, kind: ImportKind, position: number, typeOnly = false) => {
    imports.push({ specifier, kind, position, typeOnly });
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
        node.isTypeOnly === true || allNamedExportsTypeOnly === true,
      );
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(dynamicSpecifier(node.arguments[0]), "dynamic", node.getStart(sourceFile));
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        add(dynamicSpecifier(node.arguments[0]), "require", node.getStart(sourceFile));
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
): ts.ResolvedModule | undefined {
  const cacheKey = `${containingFile}\0${specifier}`;
  if (project.resolutionCache.has(cacheKey)) return project.resolutionCache.get(cacheKey);
  const compilerOptions = project.compilerOptionsByFile.get(containingFile) ?? project.compilerOptions;
  const resolved = ts.resolveModuleName(specifier, containingFile, compilerOptions, ts.sys).resolvedModule;
  project.resolutionCache.set(cacheKey, resolved);
  return resolved;
}

export function collectEdges(project: DiscoveredProject, typeAware?: TypeAwareImportIndex): SourceImport[] {
  const projectFiles = new Set(project.files.map((file) => path.normalize(file)));
  const edges: SourceImport[] = [];

  for (const file of project.files) {
    const text = project.fileContents.get(file) ?? "";
    const sourceFile = sourceFileFor(file, text);
    const imports = collectImports(sourceFile);
    const occurrences = new Map<string, number>();
    for (const current of imports) {
      const resolved = resolveModule(project, current.specifier, file);
      const resolvedFile = resolved ? path.normalize(resolved.resolvedFileName) : undefined;
      const internal = resolvedFile !== undefined && projectFiles.has(resolvedFile);
      const asset =
        isAssetSpecifier(current.specifier) || (resolvedFile !== undefined && isAssetSpecifier(resolvedFile));
      const outOfScope =
        resolvedFile !== undefined && !internal && isLocalLike(current.specifier) && !isNodeModulesPath(resolvedFile);
      const resolution = internal
        ? "internal"
        : asset
          ? "asset"
          : outOfScope
            ? "out-of-scope"
            : resolvedFile || isBuiltin(current.specifier)
              ? "external"
              : current.kind === "dynamic" || current.kind === "require" || isLocalLike(current.specifier)
                ? "unresolved"
                : "external";
      const resolutionConfidence =
        resolvedFile !== undefined || isBuiltin(current.specifier)
          ? "exact"
          : current.kind === "dynamic" || current.kind === "require" || isLocalLike(current.specifier)
            ? "ambiguous"
            : "syntactic";
      const location = sourceFile.getLineAndCharacterOfPosition(current.position);
      const fromFile = relativeToRoot(project.root, file);
      const toFile = internal || outOfScope ? relativeToRoot(project.root, resolvedFile!) : undefined;
      const occurrenceKey = [
        fromFile,
        toFile ?? "",
        current.kind,
        current.specifier,
        current.typeOnly ? "type" : "value",
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
        resolution,
        resolutionConfidence,
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
