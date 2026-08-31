import type {
  ArchitectureContract,
  ArchitectureDeclaredDependency,
  ArchitectureInteraction,
  ArchitectureModule,
  DependencyConformance,
  ModuleEdge,
  ArchitectureCycle,
} from "./ir.js";
import type { ModuleDeclarationFact } from "./declarations.js";
import { declarationContractId } from "./declarations.js";
import { findCycles } from "./graph.js";
import { compare } from "./stable.js";
import { relativeToRoot } from "./project.js";

export interface DeclarativeArchitectureProjection {
  contracts: ArchitectureContract[];
  declaredDependencies: ArchitectureDeclaredDependency[];
  interactions: ArchitectureInteraction[];
  declaredCycles: ArchitectureCycle[];
  dependencyConformance: DependencyConformance[];
}

function dependencyId(from: string, to: string, kind: string, contractId?: string): string {
  return [from, to, kind, contractId ?? ""].join("\0");
}

function interactionId(kind: string, contractId: string, from: string, to: string): string {
  return [kind, contractId, from, to].join("\0");
}

function contractEvidence(contract: ModuleDeclarationFact["contracts"][number]) {
  return [{ kind: "file" as const, id: contract.file, file: contract.file, line: contract.line }];
}

function displayFile(file: string | undefined, projectRoot?: string): string | undefined {
  return file === undefined ? undefined : projectRoot ? relativeToRoot(projectRoot, file) : file;
}

/** Project literal declaration facts into architecture-level contracts and flows. */
export function projectDeclarativeArchitecture(
  modules: readonly ArchitectureModule[],
  declarations: readonly ModuleDeclarationFact[],
  moduleEdges: readonly ModuleEdge[],
  projectRoot?: string,
): DeclarativeArchitectureProjection {
  const moduleIds = new Set(modules.map((module) => module.id));
  const contracts: ArchitectureContract[] = declarations
    .flatMap((declaration) =>
      declaration.contracts.map((contract) => ({
        id: contract.id,
        module: declaration.id,
        key: contract.key,
        kind: contract.kind,
        provenance: {
          origin: "declared" as const,
          analyzer: "architecture-declarations",
          evidence: contractEvidence(contract).map((evidence) => ({
            ...evidence,
            id: displayFile(evidence.id, projectRoot)!,
            file: displayFile(evidence.file, projectRoot),
          })),
        },
      })),
    )
    .sort((left, right) => compare(left.id, right.id));
  const contractsById = new Map(contracts.map((contract) => [contract.id, contract]));
  const declaredDependencies: ArchitectureDeclaredDependency[] = [];
  const interactions: ArchitectureInteraction[] = [];
  const dependencyKeys = new Set<string>();
  const interactionKeys = new Set<string>();

  const addDependency = (
    from: string,
    to: string,
    kind: ArchitectureDeclaredDependency["kind"],
    file: string,
    line: number,
    contractId?: string,
  ): void => {
    if (!moduleIds.has(from)) throw new Error(`Declared dependency refers to unknown module '${from}'.`);
    if (!moduleIds.has(to)) throw new Error(`Declared dependency refers to unknown module '${to}'.`);
    if (from === to) throw new Error(`Module '${from}' cannot depend on itself.`);
    if (contractId && !contractsById.has(contractId))
      throw new Error(`Declared dependency refers to unknown contract '${contractId}'.`);
    const id = dependencyId(from, to, kind, contractId);
    if (dependencyKeys.has(id)) throw new Error(`Duplicate declared dependency '${id}'.`);
    dependencyKeys.add(id);
    declaredDependencies.push({
      id,
      from,
      to,
      kind,
      ...(contractId ? { contractId } : {}),
      file: displayFile(file, projectRoot),
      line,
      provenance: {
        origin: "declared",
        analyzer: "architecture-declarations",
        derivedFrom: [contractId ?? `module:${from}`],
        evidence: [
          {
            kind: contractId ? ("contract" as const) : ("module" as const),
            id: contractId ?? from,
            file: displayFile(file, projectRoot),
            line,
          },
        ],
      },
    });
  };

  const addInteraction = (
    kind: ArchitectureInteraction["kind"],
    contractId: string,
    from: string,
    to: string,
    file: string,
    line: number,
  ): void => {
    const id = interactionId(kind, contractId, from, to);
    if (interactionKeys.has(id)) throw new Error(`Duplicate declared interaction '${id}'.`);
    interactionKeys.add(id);
    interactions.push({
      id,
      kind,
      contractId,
      from,
      to,
      file: displayFile(file, projectRoot),
      line,
      provenance: {
        origin: "declared",
        analyzer: "architecture-declarations",
        derivedFrom: [contractId],
        evidence: [{ kind: "contract", id: contractId, file: displayFile(file, projectRoot), line }],
      },
    });
  };

  for (const declaration of declarations) {
    for (const reference of declaration.dependsOn) {
      addDependency(declaration.id, reference.root, "dependsOn", declaration.file, reference.line);
    }
    for (const reference of declaration.requires) {
      const kind = reference.path[0];
      if (kind !== "query" && kind !== "command") {
        throw new Error(`requires in module '${declaration.id}' must reference a query or command contract.`);
      }
      const contractId = declarationContractId(reference.root, kind, reference.path[1] ?? "");
      const contract = contractsById.get(contractId);
      if (!contract || contract.kind !== kind) throw new Error(`Could not resolve contract '${contractId}'.`);
      addDependency(declaration.id, contract.module, "requires", declaration.file, reference.line, contractId);
      addInteraction(kind, contractId, declaration.id, contract.module, declaration.file, reference.line);
    }
    for (const reference of declaration.subscribesTo) {
      if (reference.path[0] !== "event")
        throw new Error(`subscribesTo in module '${declaration.id}' must reference an event contract.`);
      const contractId = declarationContractId(reference.root, "event", reference.path[1] ?? "");
      const contract = contractsById.get(contractId);
      if (!contract || contract.kind !== "event") throw new Error(`Could not resolve contract '${contractId}'.`);
      addDependency(declaration.id, contract.module, "subscribesTo", declaration.file, reference.line, contractId);
      // Event flow is intentionally publisher -> subscriber, the reverse of
      // the dependency edge above.
      addInteraction("event", contractId, contract.module, declaration.id, declaration.file, reference.line);
    }
  }

  const declaredEdges: ModuleEdge[] = declaredDependencies.map((dependency) => ({
    id: dependency.id,
    from: dependency.from,
    to: dependency.to,
    imports: 1,
    publicApiImports: 0,
    deepImports: 0,
    unknownImports: 1,
    files: dependency.file ? [dependency.file] : [],
    sourceEdgeIds: [],
    visibility: "unknown",
    provenance: dependency.provenance,
  }));
  const declaredCycles = findCycles([...modules], declaredEdges).map((cycle) => ({
    ...cycle,
    provenance: {
      ...cycle.provenance,
      evidence: cycle.edgeIds.map((id) => ({ kind: "declared-dependency" as const, id })),
    },
  }));
  const observedByPair = new Map<string, ModuleEdge[]>();
  for (const edge of moduleEdges) {
    const key = `${edge.from}\0${edge.to}`;
    observedByPair.set(key, [...(observedByPair.get(key) ?? []), edge]);
  }
  const declaredByPair = new Map<string, ArchitectureDeclaredDependency[]>();
  for (const dependency of declaredDependencies) {
    const key = `${dependency.from}\0${dependency.to}`;
    declaredByPair.set(key, [...(declaredByPair.get(key) ?? []), dependency]);
  }
  const pairKeys = [...new Set([...observedByPair.keys(), ...declaredByPair.keys()])].sort(compare);
  const dependencyConformance = pairKeys.map((key) => {
    const [from, to] = key.split("\0");
    const observed = observedByPair.get(key) ?? [];
    const declared = declaredByPair.get(key) ?? [];
    const status =
      observed.length > 0 && declared.length > 0
        ? "confirmed"
        : observed.length > 0
          ? "observed-only"
          : "declared-only";
    return {
      id: key,
      from: from!,
      to: to!,
      status,
      declaredDependencyIds: declared.map((entry) => entry.id).sort(compare),
      moduleEdgeIds: observed.map((entry) => entry.id).sort(compare),
      provenance: {
        origin: "derived" as const,
        analyzer: "dependency-conformance",
        derivedFrom: [...declared.map((entry) => entry.id), ...observed.map((entry) => entry.id)].sort(compare),
        evidence: [
          ...declared.map((entry) => ({ kind: "declared-dependency" as const, id: entry.id })),
          ...observed.map((entry) => ({ kind: "module-edge" as const, id: entry.id })),
        ],
      },
    } satisfies DependencyConformance;
  });

  return {
    contracts,
    declaredDependencies: declaredDependencies.sort((left, right) => compare(left.id, right.id)),
    interactions: interactions.sort((left, right) => compare(left.id, right.id)),
    declaredCycles,
    dependencyConformance,
  };
}
