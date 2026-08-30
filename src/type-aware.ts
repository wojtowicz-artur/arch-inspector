import path from "node:path";
import ts from "typescript";
import type { ImportedSymbolKind } from "./ir.js";
import type { DiscoveredProject } from "./project.js";
import { compare } from "./stable.js";

export interface TypeAwareImportSymbol {
  name: string;
  kind: ImportedSymbolKind;
}

export interface TypeAwareImportInfo {
  symbols: TypeAwareImportSymbol[];
}

export type TypeAwareImportIndex = ReadonlyMap<string, TypeAwareImportInfo>;

function normalized(file: string): string {
  return path.normalize(path.resolve(file));
}

export function typeAwareImportKey(file: string, position: number): string {
  return `${normalized(file)}\0${position}`;
}

function symbolKind(symbol: ts.Symbol | undefined): ImportedSymbolKind {
  if (!symbol) return "unknown";
  const declarations = symbol.declarations ?? [];
  let hasType = false;
  let hasValue = false;

  for (const declaration of declarations) {
    switch (declaration.kind) {
      case ts.SyntaxKind.InterfaceDeclaration:
      case ts.SyntaxKind.TypeAliasDeclaration:
      case ts.SyntaxKind.TypeParameter:
        hasType = true;
        break;
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.ClassExpression:
      case ts.SyntaxKind.EnumDeclaration:
        hasType = true;
        hasValue = true;
        break;
      case ts.SyntaxKind.FunctionDeclaration:
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.VariableDeclaration:
      case ts.SyntaxKind.BindingElement:
      case ts.SyntaxKind.ModuleDeclaration:
      case ts.SyntaxKind.SourceFile:
      case ts.SyntaxKind.GetAccessor:
      case ts.SyntaxKind.SetAccessor:
        hasValue = true;
        break;
      default:
        break;
    }
  }

  // Declaration kinds cover the common cases and make the result independent
  // of aliases. Flags fill in merged declarations and less common exports.
  hasType ||= (symbol.flags & ts.SymbolFlags.Type) !== 0;
  hasValue ||= (symbol.flags & ts.SymbolFlags.Value) !== 0;
  if (hasType && hasValue) return "both";
  if (hasType) return "type";
  if (hasValue) return "value";
  return "unknown";
}

function moduleExportName(name: ts.ModuleExportName): string {
  return name.text;
}

interface Binding {
  importedName: string;
  location: ts.Node;
}

function bindingsFor(node: ts.ImportDeclaration | ts.ExportDeclaration): Binding[] {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return [];
    const bindings: Binding[] = [];
    if (clause.name) bindings.push({ importedName: "default", location: clause.name });
    const namedBindings = clause.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      bindings.push({ importedName: "*", location: namedBindings.name });
    } else if (namedBindings && ts.isNamedImports(namedBindings)) {
      bindings.push(
        ...namedBindings.elements.map((element) => ({
          importedName: moduleExportName(element.propertyName ?? element.name),
          location: element.name,
        })),
      );
    }
    return bindings;
  }

  const exportClause = node.exportClause;
  if (!exportClause) return [];
  if (ts.isNamespaceExport(exportClause)) return [{ importedName: "*", location: exportClause.name }];
  if (!ts.isNamedExports(exportClause)) return [];
  return exportClause.elements.map((element) => ({
    importedName: moduleExportName(element.propertyName ?? element.name),
    location: element.propertyName ?? element.name,
  }));
}

function aliasedSymbol(checker: ts.TypeChecker, location: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(location);
  if (!symbol) return undefined;
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return undefined;
  }
}

function importInfo(checker: ts.TypeChecker, node: ts.ImportDeclaration | ts.ExportDeclaration): TypeAwareImportInfo {
  const symbols = bindingsFor(node)
    .map((binding) => ({ name: binding.importedName, kind: symbolKind(aliasedSymbol(checker, binding.location)) }))
    .sort((left, right) => compare(left.name, right.name) || compare(left.kind, right.kind));
  const unique = symbols.filter(
    (symbol, index) =>
      index === 0 || symbol.name !== symbols[index - 1].name || symbol.kind !== symbols[index - 1].kind,
  );
  return { symbols: unique };
}

/**
 * Build semantic metadata with a TypeScript Program. The pass is deliberately
 * opt-in: projects that only need the syntactic graph do not pay for a
 * checker, while consumers can use the same source-edge identity when they
 * need imported export names and their type/value nature.
 */
export function buildTypeAwareImportIndex(project: DiscoveredProject): TypeAwareImportIndex {
  const options = project.compilerOptions;
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile?.bind(host);
  if (readFile) {
    host.readFile = (fileName) => project.fileContents.get(normalized(fileName)) ?? readFile(fileName);
  }
  const program = ts.createProgram({ rootNames: project.files, options, host });
  const checker = program.getTypeChecker();
  const projectFiles = new Set(project.files.map(normalized));
  const result = new Map<string, TypeAwareImportInfo>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!projectFiles.has(normalized(sourceFile.fileName))) continue;
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        result.set(typeAwareImportKey(sourceFile.fileName, node.getStart(sourceFile)), importInfo(checker, node));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return result;
}
