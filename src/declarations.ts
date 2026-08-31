import path from "node:path";
import ts from "typescript";
import type { DiscoveredProject } from "./project.js";
import { isWithin, relativeToRoot } from "./project.js";

export const CONTRACTS_PACKAGE = "@arch-inspector/contracts" as const;

export type DeclarationContractKind = "query" | "command" | "event";

export interface ModuleDeclarationContract {
  readonly id: string;
  readonly moduleId: string;
  readonly key: string;
  readonly kind: DeclarationContractKind;
  readonly file: string;
  readonly line: number;
}

export interface ModuleDeclarationReference {
  readonly root: string;
  readonly path: readonly string[];
  readonly file: string;
  readonly line: number;
}

export interface ModuleDeclarationFact {
  readonly id: string;
  readonly file: string;
  readonly root: string;
  readonly line: number;
  readonly publicEntrypoints: readonly string[];
  readonly contracts: readonly ModuleDeclarationContract[];
  readonly dependsOn: readonly ModuleDeclarationReference[];
  readonly requires: readonly ModuleDeclarationReference[];
  readonly subscribesTo: readonly ModuleDeclarationReference[];
}

export class ArchitectureDeclarationError extends Error {
  readonly code = "INVALID_ARCHITECTURE_DECLARATION" as const;

  constructor(
    readonly file: string,
    readonly line: number,
    message: string,
  ) {
    super(`${file}:${line}: ${message}`);
    this.name = "ArchitectureDeclarationError";
  }
}

interface ImportBinding {
  readonly local: string;
  readonly source: string;
  readonly imported: string;
  readonly targetFile?: string;
  readonly typeOnly: boolean;
}

interface ParsedDeclaration {
  readonly fact: ModuleDeclarationFact;
  /** Names that refer to the module declaration itself (not arbitrary exports). */
  readonly moduleExports: readonly string[];
  readonly imports: readonly ImportBinding[];
}

function sourceFileFor(file: string, text: string): ts.SourceFile {
  const scriptKind = /\.tsx?$/i.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
}

function unwrap(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    current.kind === ts.SyntaxKind.SatisfiesExpression
  ) {
    current = (current as ts.ParenthesizedExpression | ts.AsExpression | ts.TypeAssertion | ts.SatisfiesExpression)
      .expression;
  }
  return current;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function fail(sourceFile: ts.SourceFile, node: ts.Node, message: string): never {
  throw new ArchitectureDeclarationError(sourceFile.fileName, lineOf(sourceFile, node), message);
}

function propertyName(sourceFile: ts.SourceFile, node: ts.PropertyName): string {
  if (node.getChildCount(sourceFile) > 0 && ts.isComputedPropertyName(node)) {
    fail(sourceFile, node, "Computed property names are not supported in architecture declarations.");
  }
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  fail(sourceFile, node, "Architecture declaration property names must be literal identifiers or strings.");
}

function objectProperties(sourceFile: ts.SourceFile, node: ts.Node, field: string): Map<string, ts.PropertyAssignment> {
  const value = unwrap(node);
  if (!ts.isObjectLiteralExpression(value)) fail(sourceFile, node, `${field} must be a literal object.`);
  const properties = new Map<string, ts.PropertyAssignment>();
  for (const property of value.properties) {
    if (!ts.isPropertyAssignment(property)) {
      fail(sourceFile, property, `${field} must not contain spreads, shorthand properties, methods or accessors.`);
    }
    const key = propertyName(sourceFile, property.name);
    if (properties.has(key)) fail(sourceFile, property, `Duplicate property '${key}' in ${field}.`);
    properties.set(key, property);
  }
  return properties;
}

function stringLiteral(sourceFile: ts.SourceFile, node: ts.Node, field: string): string {
  const value = unwrap(node);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  fail(sourceFile, node, `${field} must be a string literal.`);
}

function stringArray(sourceFile: ts.SourceFile, node: ts.Node, field: string): string[] {
  const value = unwrap(node);
  if (!ts.isArrayLiteralExpression(value)) fail(sourceFile, node, `${field} must be a literal array.`);
  const result: string[] = [];
  for (const element of value.elements) {
    if (ts.isSpreadElement(element)) fail(sourceFile, element, `${field} must not contain spreads.`);
    result.push(stringLiteral(sourceFile, element, field));
  }
  return result;
}

function referencePath(sourceFile: ts.SourceFile, node: ts.Node, field: string): ModuleDeclarationReference {
  let current = unwrap(node);
  const segments: string[] = [];
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (current.questionDotToken) {
      fail(sourceFile, current, `${field} must use a non-optional static reference.`);
    }
    if (ts.isPropertyAccessExpression(current)) {
      segments.unshift(current.name.text);
      current = unwrap(current.expression);
      continue;
    }
    const argument = current.argumentExpression ? unwrap(current.argumentExpression) : undefined;
    if (!argument || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) {
      fail(sourceFile, current, `${field} must use literal property names in static references.`);
    }
    segments.unshift(argument.text);
    current = unwrap(current.expression);
  }
  if (!ts.isIdentifier(current) || (segments.length === 0 && field !== "dependsOn")) {
    fail(sourceFile, node, `${field} must reference a statically imported module or contract.`);
  }
  return {
    root: current.text,
    path: segments,
    file: sourceFile.fileName,
    line: lineOf(sourceFile, node),
  };
}

function contractCall(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  helpers: ReadonlyMap<string, DeclarationContractKind>,
  namespaces: ReadonlySet<string>,
  section: string,
): DeclarationContractKind {
  const value = unwrap(node);
  if (!ts.isCallExpression(value)) {
    fail(sourceFile, node, `${section} entries must be direct calls to an imported contract helper.`);
  }
  if (value.questionDotToken) {
    fail(sourceFile, value, `${section} entries must use a direct, non-optional contract helper call.`);
  }
  const kind = ts.isIdentifier(value.expression)
    ? helpers.get(value.expression.text)
    : ts.isPropertyAccessExpression(value.expression) &&
        ts.isIdentifier(value.expression.expression) &&
        namespaces.has(value.expression.expression.text) &&
        !value.expression.questionDotToken
      ? value.expression.name.text === "defineQuery"
        ? "query"
        : value.expression.name.text === "defineCommand"
          ? "command"
          : value.expression.name.text === "defineEvent"
            ? "event"
            : undefined
      : undefined;
  if (!kind) fail(sourceFile, value, `${section} entry uses a helper that was not imported from ${CONTRACTS_PACKAGE}.`);
  if (value.arguments.length !== 0)
    fail(sourceFile, value, `${section} contract helpers must not receive runtime arguments.`);
  return kind;
}

function parseImports(sourceFile: ts.SourceFile, project: DiscoveredProject): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  const compilerOptions = project.compilerOptionsByFile.get(sourceFile.fileName) ?? project.compilerOptions;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const source = statement.moduleSpecifier.text;
    const resolved = ts.resolveModuleName(source, sourceFile.fileName, compilerOptions, ts.sys).resolvedModule;
    const targetFile = resolved?.resolvedFileName ? path.normalize(resolved.resolvedFileName) : undefined;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name)
      bindings.push({ local: clause.name.text, source, imported: "default", targetFile, typeOnly: clause.isTypeOnly });
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      bindings.push({
        local: clause.namedBindings.name.text,
        source,
        imported: "*",
        targetFile,
        typeOnly: clause.isTypeOnly,
      });
    } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.push({
          local: element.name.text,
          source,
          imported: (element.propertyName ?? element.name).text,
          targetFile,
          typeOnly: clause.isTypeOnly || element.isTypeOnly,
        });
      }
    }
  }
  return bindings;
}

function directModuleCalls(
  sourceFile: ts.SourceFile,
  helperNames: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && helperNames.has(node.expression.text)) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          namespaces.has(node.expression.expression.text) &&
          node.expression.name.text === "defineModule"))
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

function parseDeclaration(file: string, project: DiscoveredProject): ParsedDeclaration | undefined {
  const sourceFile = sourceFileFor(file, project.fileContents.get(file) ?? "");
  const imports = parseImports(sourceFile, project);
  const helpers = new Map<string, DeclarationContractKind>();
  const moduleHelpers = new Set<string>();
  const namespaces = new Set<string>();
  for (const binding of imports) {
    if (binding.source !== CONTRACTS_PACKAGE) continue;
    if (binding.typeOnly) continue;
    if (binding.imported === "defineQuery") helpers.set(binding.local, "query");
    else if (binding.imported === "defineCommand") helpers.set(binding.local, "command");
    else if (binding.imported === "defineEvent") helpers.set(binding.local, "event");
    else if (binding.imported === "defineModule") moduleHelpers.add(binding.local);
    else if (binding.imported === "*") namespaces.add(binding.local);
  }
  const moduleCalls = directModuleCalls(sourceFile, moduleHelpers, namespaces);
  if (moduleCalls.length === 0) return undefined;
  if (moduleCalls.length !== 1)
    fail(sourceFile, moduleCalls[1] ?? moduleCalls[0]!, "A module.arch.ts file must define exactly one module.");
  const call = moduleCalls[0]!;
  if (call.questionDotToken || (ts.isPropertyAccessExpression(call.expression) && call.expression.questionDotToken)) {
    fail(sourceFile, call, "defineModule must use a direct, non-optional helper call.");
  }
  let container: ts.Node = call;
  while (
    container.parent &&
    (ts.isAsExpression(container.parent) ||
      ts.isTypeAssertionExpression(container.parent) ||
      container.parent.kind === ts.SyntaxKind.SatisfiesExpression ||
      ts.isParenthesizedExpression(container.parent))
  ) {
    container = container.parent;
  }
  if (container.parent && ts.isVariableDeclaration(container.parent)) {
    const statement = container.parent.parent.parent;
    if (
      !ts.isVariableStatement(statement) ||
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) !== true
    ) {
      fail(
        sourceFile,
        call,
        "The module declaration must be exported directly; re-exports and wrappers are not supported.",
      );
    }
  } else if (container.parent && ts.isExportAssignment(container.parent)) {
    // `export default defineModule({...})` is also a direct declaration.
  } else if (
    !call.parent ||
    !(
      ts.isAsExpression(call.parent) ||
      ts.isTypeAssertionExpression(call.parent) ||
      call.parent.kind === ts.SyntaxKind.SatisfiesExpression ||
      ts.isParenthesizedExpression(call.parent)
    )
  ) {
    fail(
      sourceFile,
      call,
      "defineModule must be used as a direct variable initializer; wrapper calls are not supported.",
    );
  }
  if (call.arguments.length !== 1) fail(sourceFile, call, "defineModule requires exactly one literal object argument.");
  const object = objectProperties(sourceFile, call.arguments[0]!, "defineModule");
  const idProperty = object.get("id");
  if (!idProperty) fail(sourceFile, call, "defineModule requires an id field.");
  const id = stringLiteral(sourceFile, idProperty.initializer, "id");
  if (id.trim() === "") fail(sourceFile, idProperty, "Module id must not be empty.");
  const publicEntrypoints = object.has("publicEntrypoints")
    ? stringArray(sourceFile, object.get("publicEntrypoints")!.initializer, "publicEntrypoints")
    : [];
  if (new Set(publicEntrypoints).size !== publicEntrypoints.length) {
    fail(sourceFile, object.get("publicEntrypoints")!, "publicEntrypoints must not contain duplicates.");
  }
  const contracts: ModuleDeclarationContract[] = [];
  const sections: Array<[string, DeclarationContractKind]> = [
    ["queries", "query"],
    ["commands", "command"],
    ["events", "event"],
  ];
  for (const [section, expectedKind] of sections) {
    const sectionProperty = object.get(section);
    if (!sectionProperty) continue;
    const sectionProperties = objectProperties(sourceFile, sectionProperty.initializer, section);
    for (const [key, property] of sectionProperties) {
      if (key.length === 0) fail(sourceFile, property, `Contract key in '${section}' must not be empty.`);
      const actualKind = contractCall(sourceFile, property.initializer, helpers, namespaces, `${section}.${key}`);
      if (actualKind !== expectedKind) {
        fail(
          sourceFile,
          property,
          `${section}.${key} requires define${expectedKind[0]!.toUpperCase()}${expectedKind.slice(1)}().`,
        );
      }
      contracts.push({
        id: declarationContractId(id, actualKind, key),
        moduleId: id,
        key,
        kind: actualKind,
        file,
        line: lineOf(sourceFile, property),
      });
    }
  }
  const refs = (field: "dependsOn" | "requires" | "subscribesTo"): ModuleDeclarationReference[] => {
    const property = object.get(field);
    if (!property) return [];
    const value = unwrap(property.initializer);
    if (!ts.isArrayLiteralExpression(value))
      fail(sourceFile, property.initializer, `${field} must be a literal array.`);
    return value.elements.map((element) => {
      if (ts.isSpreadElement(element)) fail(sourceFile, element, `${field} must not contain spreads.`);
      return referencePath(sourceFile, element, field);
    });
  };
  const knownFields = new Set([
    "id",
    "publicEntrypoints",
    "queries",
    "commands",
    "events",
    "dependsOn",
    "requires",
    "subscribesTo",
  ]);
  for (const key of object.keys())
    if (!knownFields.has(key)) fail(sourceFile, object.get(key)!, `Unknown defineModule field '${key}'.`);
  const fact: ModuleDeclarationFact = {
    id,
    file,
    root: path.dirname(file),
    line: lineOf(sourceFile, call),
    publicEntrypoints,
    contracts,
    dependsOn: refs("dependsOn"),
    requires: refs("requires"),
    subscribesTo: refs("subscribesTo"),
  };
  const moduleExports = sourceFile.statements
    .filter((statement): statement is ts.VariableStatement => ts.isVariableStatement(statement))
    .filter(
      (statement) => statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true,
    )
    .filter((statement) =>
      statement.declarationList.declarations.some(
        (declaration) => unwrap(declaration.initializer ?? declaration) === call,
      ),
    )
    .flatMap((statement) =>
      statement.declarationList.declarations.flatMap((declaration) => {
        if (unwrap(declaration.initializer ?? declaration) !== call) return [];
        if (!ts.isIdentifier(declaration.name)) {
          fail(sourceFile, declaration.name, "The module declaration must be exported under an identifier.");
        }
        return [declaration.name.text];
      }),
    );
  if (
    sourceFile.statements.some((statement) => ts.isExportAssignment(statement) && unwrap(statement.expression) === call)
  ) {
    moduleExports.push("default");
  }
  return { fact, moduleExports, imports };
}

function declarationFiles(project: DiscoveredProject): string[] {
  return project.files.filter((file) => path.basename(file).toLowerCase() === "module.arch.ts").sort();
}

function declarationForReference(
  declaration: ParsedDeclaration,
  reference: ModuleDeclarationReference,
  byFile: ReadonlyMap<string, ParsedDeclaration>,
): ParsedDeclaration {
  const binding = declaration.imports.find((candidate) => candidate.local === reference.root);
  if (binding?.typeOnly) {
    throw new ArchitectureDeclarationError(
      declaration.fact.file,
      reference.line,
      `Architecture reference '${reference.root}' must use a value import, not an import type.`,
    );
  }
  const target = binding?.targetFile ? byFile.get(path.normalize(binding.targetFile)) : undefined;
  if (!target) {
    throw new ArchitectureDeclarationError(
      declaration.fact.file,
      reference.line,
      `Could not resolve architecture declaration reference '${reference.root}${reference.path.length ? `.${reference.path.join(".")}` : ""}'.`,
    );
  }
  if (binding && binding.imported !== "*" && !target.moduleExports.includes(binding.imported)) {
    throw new ArchitectureDeclarationError(
      declaration.fact.file,
      reference.line,
      `Could not resolve exported module '${binding.imported}' from '${binding.source}'.`,
    );
  }
  if (binding?.imported === "*") {
    const exportedModule = reference.path[0];
    if (!exportedModule || !target.moduleExports.includes(exportedModule)) {
      throw new ArchitectureDeclarationError(
        declaration.fact.file,
        reference.line,
        `Could not resolve exported module '${reference.root}${reference.path.length ? `.${reference.path.join(".")}` : ""}'.`,
      );
    }
  }
  return target;
}

function referencePathForTarget(
  declaration: ParsedDeclaration,
  reference: ModuleDeclarationReference,
): readonly string[] {
  const binding = declaration.imports.find((candidate) => candidate.local === reference.root);
  if (binding?.imported === "*") return reference.path.slice(1);
  return reference.path;
}

function resolveReferences(parsed: readonly ParsedDeclaration[]): ModuleDeclarationFact[] {
  const byFile = new Map(parsed.map((entry) => [path.normalize(entry.fact.file), entry]));
  return parsed.map((entry) => {
    const resolveContract = (
      reference: ModuleDeclarationReference,
      expected: DeclarationContractKind | "query-or-command",
    ): ModuleDeclarationReference => {
      const target = declarationForReference(entry, reference, byFile);
      const targetPath = referencePathForTarget(entry, reference);
      if (targetPath.length !== 2 || !["queries", "commands", "events"].includes(targetPath[0]!)) {
        throw new ArchitectureDeclarationError(
          entry.fact.file,
          reference.line,
          `Reference '${reference.root}.${reference.path.join(".")}' must select a contract section and key.`,
        );
      }
      const sectionKind = targetPath[0] === "queries" ? "query" : targetPath[0] === "commands" ? "command" : "event";
      if (
        (expected === "query-or-command" && sectionKind === "event") ||
        (expected !== "query-or-command" && sectionKind !== expected)
      ) {
        throw new ArchitectureDeclarationError(
          entry.fact.file,
          reference.line,
          `${expected === "event" ? "subscribesTo" : "requires"} accepts only ${expected === "event" ? "event" : "query or command"} contracts.`,
        );
      }
      const contract = target.fact.contracts.find(
        (candidate) =>
          candidate.key === targetPath[1] &&
          (expected === "query-or-command" ? candidate.kind !== "event" : candidate.kind === expected),
      );
      if (!contract) {
        throw new ArchitectureDeclarationError(
          entry.fact.file,
          reference.line,
          `Could not resolve contract '${reference.root}.${reference.path.join(".")}'.`,
        );
      }
      if (target.fact.id === entry.fact.id) {
        throw new ArchitectureDeclarationError(
          entry.fact.file,
          reference.line,
          `Module '${entry.fact.id}' cannot reference its own contract.`,
        );
      }
      return { ...reference, root: target.fact.id, path: [contract.kind, contract.key] };
    };
    const dependencies = entry.fact.dependsOn.map((reference) => {
      const target = declarationForReference(entry, reference, byFile);
      const targetPath = referencePathForTarget(entry, reference);
      if (targetPath.length !== 0)
        throw new ArchitectureDeclarationError(
          entry.fact.file,
          reference.line,
          "dependsOn entries must be module identifiers.",
        );
      if (target.fact.id === entry.fact.id)
        throw new ArchitectureDeclarationError(
          entry.fact.file,
          reference.line,
          `Module '${entry.fact.id}' cannot depend on itself.`,
        );
      return { ...reference, root: target.fact.id, path: [] };
    });
    const requires = entry.fact.requires.map((reference) => resolveContract(reference, "query-or-command"));
    const subscribesTo = entry.fact.subscribesTo.map((reference) => resolveContract(reference, "event"));
    const assertUnique = (references: readonly ModuleDeclarationReference[], field: string): void => {
      const seen = new Set<string>();
      for (const reference of references) {
        const key = `${reference.root}\0${reference.path.join("\0")}`;
        if (seen.has(key)) {
          throw new ArchitectureDeclarationError(
            entry.fact.file,
            reference.line,
            `Duplicate ${field} reference '${reference.root}.${reference.path.join(".")}'.`,
          );
        }
        seen.add(key);
      }
    };
    assertUnique(dependencies, "dependsOn");
    assertUnique(requires, "requires");
    assertUnique(subscribesTo, "subscribesTo");
    return { ...entry.fact, dependsOn: dependencies, requires, subscribesTo };
  });
}

/** Extract all literal module.arch.ts declarations without importing application code. */
export function collectModuleDeclarations(project: DiscoveredProject): readonly ModuleDeclarationFact[] {
  const parsed = declarationFiles(project).flatMap((file) => {
    const value = parseDeclaration(file, project);
    if (!value) {
      throw new ArchitectureDeclarationError(
        file,
        1,
        `A module.arch.ts file must contain exactly one direct defineModule call imported from ${CONTRACTS_PACKAGE}.`,
      );
    }
    return [value];
  });
  const ids = new Set<string>();
  const roots = new Set<string>();
  for (const declaration of parsed) {
    if (ids.has(declaration.fact.id)) {
      throw new ArchitectureDeclarationError(
        declaration.fact.file,
        declaration.fact.line,
        `Duplicate module id '${declaration.fact.id}'.`,
      );
    }
    ids.add(declaration.fact.id);
    if (roots.has(path.normalize(declaration.fact.root))) {
      throw new ArchitectureDeclarationError(
        declaration.fact.file,
        declaration.fact.line,
        `Duplicate module declaration root '${declaration.fact.root}'.`,
      );
    }
    roots.add(path.normalize(declaration.fact.root));
  }
  return resolveReferences(parsed).sort(
    (left, right) => left.id.localeCompare(right.id) || left.file.localeCompare(right.file),
  );
}

export function declarationEntrypointFiles(project: DiscoveredProject, declaration: ModuleDeclarationFact): string[] {
  const files = new Set(project.files.map((file) => path.normalize(file)));
  const seen = new Set<string>();
  return declaration.publicEntrypoints.map((entrypoint) => {
    if (!entrypoint.startsWith(".")) {
      throw new ArchitectureDeclarationError(
        declaration.file,
        declaration.line,
        `publicEntrypoints must be relative paths; received '${entrypoint}'.`,
      );
    }
    const absolute = path.normalize(path.resolve(declaration.root, entrypoint));
    if (!isWithin(declaration.root, absolute)) {
      throw new ArchitectureDeclarationError(
        declaration.file,
        declaration.line,
        `Public entrypoint '${entrypoint}' is outside module root.`,
      );
    }
    if (!files.has(absolute)) {
      throw new ArchitectureDeclarationError(
        declaration.file,
        declaration.line,
        `Public entrypoint '${entrypoint}' is not in the analysis scope.`,
      );
    }
    const relative = relativeToRoot(project.root, absolute);
    if (seen.has(relative)) {
      throw new ArchitectureDeclarationError(
        declaration.file,
        declaration.line,
        `Public entrypoint '${entrypoint}' resolves to a duplicate file.`,
      );
    }
    seen.add(relative);
    return relative;
  });
}

export function declarationContractId(moduleId: string, kind: DeclarationContractKind, key: string): string {
  return `${moduleId}:${kind}:${key}`;
}
