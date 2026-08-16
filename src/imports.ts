import path from "node:path";
import ts from "typescript";
import type { ArchitectureEdge, ImportKind } from "./ir.js";
import { relativeToRoot, type DiscoveredProject } from "./project.js";

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
      : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
}

function collectImports(sourceFile: ts.SourceFile): RawImport[] {
  const imports: RawImport[] = [];
  const add = (specifier: string, kind: ImportKind, position: number, typeOnly = false) => {
    imports.push({ specifier, kind, position, typeOnly });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, "static", node.getStart(sourceFile), node.importClause?.isTypeOnly ?? false);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, "export", node.getStart(sourceFile), false);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        add(node.arguments[0].text, "dynamic", node.getStart(sourceFile));
      else if (ts.isIdentifier(node.expression) && node.expression.text === "require")
        add(node.arguments[0].text, "require", node.getStart(sourceFile));
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

export function collectEdges(
  project: DiscoveredProject,
  fileToModule: Map<string, string>,
  moduleEntrypoints: Map<string, Set<string>>,
): ArchitectureEdge[] {
  const projectFiles = new Set(project.files.map((file) => path.normalize(file)));
  const edges: ArchitectureEdge[] = [];

  for (const file of project.files) {
    const text = ts.sys.readFile(file) ?? "";
    const sourceFile = sourceFileFor(file, text);
    const imports = collectImports(sourceFile);
    for (const current of imports) {
      const resolved = ts.resolveModuleName(current.specifier, file, project.compilerOptions, ts.sys).resolvedModule;
      const resolvedFile = resolved ? path.normalize(resolved.resolvedFileName) : undefined;
      const internal = resolvedFile !== undefined && projectFiles.has(resolvedFile);
      const asset =
        isAssetSpecifier(current.specifier) || (resolvedFile !== undefined && isAssetSpecifier(resolvedFile));
      const resolution = internal
        ? "internal"
        : asset
          ? "asset"
          : resolvedFile || isBuiltin(current.specifier) || !isLocalLike(current.specifier)
            ? "external"
            : "unresolved";
      const fromModule = fileToModule.get(file)!;
      const toModule = internal ? fileToModule.get(resolvedFile!) : undefined;
      const targetEntrypoints = toModule ? moduleEntrypoints.get(toModule) : undefined;
      const publicApi = internal && targetEntrypoints?.has(resolvedFile!) === true;
      const location = sourceFile.getLineAndCharacterOfPosition(current.position);
      const fromFile = relativeToRoot(project.root, file);
      const toFile = internal ? relativeToRoot(project.root, resolvedFile!) : undefined;
      edges.push({
        id: `${fromFile}:${location.line + 1}:${location.character + 1}:${current.kind}:${current.specifier}`,
        fromFile,
        ...(toFile ? { toFile } : {}),
        fromModule,
        ...(toModule ? { toModule } : {}),
        specifier: current.specifier,
        importKind: current.kind,
        resolution,
        typeOnly: current.typeOnly,
        publicApi,
        location: { line: location.line + 1, column: location.character + 1 },
        provenance: { origin: "source" },
      });
    }
  }

  return edges.sort((a, b) => a.id.localeCompare(b.id));
}
