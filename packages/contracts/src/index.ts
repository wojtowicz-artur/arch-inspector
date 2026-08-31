/**
 * A deliberately small, dependency-free vocabulary for architecture
 * declarations.  Type parameters are compile-time only; the emitted values
 * contain identifiers and ownership metadata, never application constructors
 * or schemas.
 */

export type ContractKind = "query" | "command" | "event";

declare const inputType: unique symbol;
declare const outputType: unique symbol;
declare const payloadType: unique symbol;
declare const draftType: unique symbol;

const draftObjects = new WeakSet<object>();
const materializedObjects = new WeakSet<object>();
const moduleObjects = new WeakSet<object>();

export interface QueryContract<Input = unknown, Output = unknown> {
  readonly id: string;
  readonly key: string;
  readonly module: string;
  readonly kind: "query";
  readonly _input?: Input;
  readonly _output?: Output;
  readonly [inputType]?: (value: Input) => Input;
  readonly [outputType]?: (value: Output) => Output;
}

export interface CommandContract<Input = unknown, Output = unknown> {
  readonly id: string;
  readonly key: string;
  readonly module: string;
  readonly kind: "command";
  readonly _input?: Input;
  readonly _output?: Output;
  readonly [inputType]?: (value: Input) => Input;
  readonly [outputType]?: (value: Output) => Output;
}

export interface EventContract<Payload = unknown> {
  readonly id: string;
  readonly key: string;
  readonly module: string;
  readonly kind: "event";
  readonly _payload?: Payload;
  readonly [payloadType]?: (value: Payload) => Payload;
}

export type InputOf<Contract> = Contract extends { readonly _input?: infer Input } ? Input : never;

export type OutputOf<Contract> = Contract extends { readonly _output?: infer Output } ? Output : never;

export type PayloadOf<Contract> = Contract extends { readonly _payload?: infer Payload } ? Payload : never;

type QuerySection = Record<string, QueryDraft<any, any>>;
type CommandSection = Record<string, CommandDraft<any, any>>;
type EventSection = Record<string, EventDraft<any>>;

type MaterializedQueries<T extends QuerySection> = {
  readonly [Key in keyof T]: QueryContract<InputOf<T[Key]>, OutputOf<T[Key]>>;
};
type MaterializedCommands<T extends CommandSection> = {
  readonly [Key in keyof T]: CommandContract<InputOf<T[Key]>, OutputOf<T[Key]>>;
};
type MaterializedEvents<T extends EventSection> = {
  readonly [Key in keyof T]: EventContract<PayloadOf<T[Key]>>;
};

export interface ModuleDefinition<
  Queries extends QuerySection = QuerySection,
  Commands extends CommandSection = CommandSection,
  Events extends EventSection = EventSection,
> {
  readonly id: string;
  readonly publicEntrypoints: readonly string[];
  readonly queries: MaterializedQueries<Queries>;
  readonly commands: MaterializedCommands<Commands>;
  readonly events: MaterializedEvents<Events>;
  readonly dependsOn: readonly ModuleDefinition[];
  readonly requires: readonly (QueryContract<any, any> | CommandContract<any, any>)[];
  readonly subscribesTo: readonly EventContract<any>[];
}

interface QueryDraft<Input, Output> {
  readonly kind: "query";
  readonly [draftType]: true;
  readonly _input?: Input;
  readonly _output?: Output;
  readonly [inputType]?: (value: Input) => Input;
  readonly [outputType]?: (value: Output) => Output;
}

interface CommandDraft<Input, Output> {
  readonly kind: "command";
  readonly [draftType]: true;
  readonly _input?: Input;
  readonly _output?: Output;
  readonly [inputType]?: (value: Input) => Input;
  readonly [outputType]?: (value: Output) => Output;
}

interface EventDraft<Payload> {
  readonly kind: "event";
  readonly [draftType]: true;
  readonly _payload?: Payload;
  readonly [payloadType]?: (value: Payload) => Payload;
}

type ContractDraft = QueryDraft<unknown, unknown> | CommandDraft<unknown, unknown> | EventDraft<unknown>;

type ModuleInput<
  Queries extends Record<string, QueryDraft<any, any>> = Record<string, QueryDraft<any, any>>,
  Commands extends Record<string, CommandDraft<any, any>> = Record<string, CommandDraft<any, any>>,
  Events extends Record<string, EventDraft<any>> = Record<string, EventDraft<any>>,
> = {
  readonly id: string;
  readonly publicEntrypoints?: readonly string[];
  readonly queries?: Queries;
  readonly commands?: Commands;
  readonly events?: Events;
  readonly dependsOn?: readonly ModuleDefinition[];
  readonly requires?: readonly (QueryContract<any, any> | CommandContract<any, any>)[];
  readonly subscribesTo?: readonly EventContract<any>[];
};

/** Input shape accepted by `defineModule`, useful for `satisfies` annotations. */
export type ModuleDefinitionInput<
  Queries extends Record<string, QueryDraft<any, any>> = Record<string, QueryDraft<any, any>>,
  Commands extends Record<string, CommandDraft<any, any>> = Record<string, CommandDraft<any, any>>,
  Events extends Record<string, EventDraft<any>> = Record<string, EventDraft<any>>,
> = ModuleInput<Queries, Commands, Events>;

function freeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested);
  if (Array.isArray(value)) {
    for (const nested of value) freeze(nested);
  }
  return Object.freeze(value);
}

function mark<T extends object>(value: T, registry: WeakSet<object>): T {
  registry.add(value);
  return value;
}

function contractId(module: string, kind: ContractKind, key: string): string {
  return `${module}:${kind}:${key}`;
}

function assertKey(key: string, section: string): void {
  if (key.length === 0) throw new Error(`Contract key in '${section}' must not be empty.`);
}

function optionalArray(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return [...value];
}

function assertContract(value: unknown, expected: ContractKind, field: string): asserts value is ContractDraft {
  if (
    !value ||
    typeof value !== "object" ||
    !Object.prototype.hasOwnProperty.call(value, "kind") ||
    !draftObjects.has(value)
  ) {
    throw new Error(`${field} must reference a contract created by @arch-inspector/contracts.`);
  }
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== expected) throw new Error(`${field} must reference a ${expected} contract; received ${String(kind)}.`);
}

function materializeSection<T extends Record<string, ContractDraft>>(
  module: string,
  sectionName: string,
  values: T | undefined,
  expected: ContractKind,
): Record<string, ContractDraft> {
  const result: Record<string, ContractDraft> = {};
  if (values !== undefined && (!values || typeof values !== "object" || Array.isArray(values))) {
    throw new Error(`${sectionName} must be an object.`);
  }
  for (const [key, draft] of Object.entries(values ?? {})) {
    assertKey(key, sectionName);
    assertContract(draft, expected, `${sectionName}.${key}`);
    const contract = mark(
      {
        id: contractId(module, expected, key),
        key,
        module,
        kind: expected,
      } as unknown as ContractDraft,
      materializedObjects,
    );
    result[key] = freeze(contract);
  }
  return result;
}

function ensureReference(value: unknown, field: string): ContractDraft & { id: string; module: string; key: string } {
  if (!value || typeof value !== "object") throw new Error(`${field} must reference a contract.`);
  const candidate = value as Partial<ContractDraft> & { id?: unknown; module?: unknown; key?: unknown };
  if (candidate.kind !== "query" && candidate.kind !== "command" && candidate.kind !== "event") {
    throw new Error(`${field} must reference a contract created by @arch-inspector/contracts.`);
  }
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.module !== "string" ||
    typeof candidate.key !== "string" ||
    !materializedObjects.has(candidate as object)
  ) {
    throw new Error(`${field} must reference a materialized module contract.`);
  }
  return candidate as ContractDraft & { id: string; module: string; key: string };
}

export function defineQuery<Input = unknown, Output = unknown>(): QueryDraft<Input, Output> {
  if (arguments.length !== 0) throw new Error("defineQuery does not accept runtime arguments.");
  const draft = mark({ kind: "query" } as QueryDraft<Input, Output>, draftObjects);
  return freeze(draft);
}

export function defineCommand<Input = unknown, Output = unknown>(): CommandDraft<Input, Output> {
  if (arguments.length !== 0) throw new Error("defineCommand does not accept runtime arguments.");
  const draft = mark({ kind: "command" } as CommandDraft<Input, Output>, draftObjects);
  return freeze(draft);
}

export function defineEvent<Payload = unknown>(): EventDraft<Payload> {
  if (arguments.length !== 0) throw new Error("defineEvent does not accept runtime arguments.");
  const draft = mark({ kind: "event" } as EventDraft<Payload>, draftObjects);
  return freeze(draft);
}

export function defineModule<
  Queries extends Record<string, QueryDraft<any, any>> = Record<string, QueryDraft<any, any>>,
  Commands extends Record<string, CommandDraft<any, any>> = Record<string, CommandDraft<any, any>>,
  Events extends Record<string, EventDraft<any>> = Record<string, EventDraft<any>>,
>(input: ModuleInput<Queries, Commands, Events>): ModuleDefinition<Queries, Commands, Events> {
  if (arguments.length !== 1) throw new Error("defineModule requires exactly one argument.");
  if (!input || typeof input !== "object") throw new Error("defineModule requires an object.");
  const allowedFields = new Set([
    "id",
    "publicEntrypoints",
    "queries",
    "commands",
    "events",
    "dependsOn",
    "requires",
    "subscribesTo",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedFields.has(key)) throw new Error(`Unknown defineModule field '${key}'.`);
  }
  if (typeof input.id !== "string" || input.id.trim() === "") throw new Error("Module id must be a non-empty string.");
  const id = input.id;
  const queries = materializeSection(id, "queries", input.queries, "query") as Queries;
  const commands = materializeSection(id, "commands", input.commands, "command") as Commands;
  const events = materializeSection(id, "events", input.events, "event") as Events;

  const publicEntrypoints = optionalArray(input.publicEntrypoints, "publicEntrypoints").map((entrypoint) => {
    if (typeof entrypoint !== "string" || entrypoint.length === 0 || !entrypoint.startsWith(".")) {
      throw new Error(`publicEntrypoints for module '${id}' must contain relative paths.`);
    }
    return entrypoint;
  });
  if (new Set(publicEntrypoints).size !== publicEntrypoints.length) {
    throw new Error(`Module '${id}' declares a duplicate public entrypoint.`);
  }
  const dependsOn = optionalArray(input.dependsOn, "dependsOn") as ModuleDefinition[];
  for (const dependency of dependsOn) {
    if (!dependency || typeof dependency.id !== "string" || !moduleObjects.has(dependency)) {
      throw new Error(`dependsOn for module '${id}' contains an invalid module.`);
    }
    if (dependency.id === id) throw new Error(`Module '${id}' cannot depend on itself.`);
  }
  if (new Set(dependsOn.map((dependency) => dependency.id)).size !== dependsOn.length) {
    throw new Error(`Module '${id}' declares a duplicate module dependency.`);
  }
  const requires = optionalArray(input.requires, "requires") as (QueryContract<any, any> | CommandContract<any, any>)[];
  for (const [index, contract] of requires.entries()) {
    const value = ensureReference(contract, `requires[${index}]`);
    if (value.kind !== "query" && value.kind !== "command") {
      throw new Error(`requires[${index}] must reference a query or command contract.`);
    }
    if (value.module === id) throw new Error(`Module '${id}' cannot require its own contract.`);
  }
  const subscribesTo = optionalArray(input.subscribesTo, "subscribesTo") as EventContract<any>[];
  for (const [index, contract] of subscribesTo.entries()) {
    const value = ensureReference(contract, `subscribesTo[${index}]`);
    if (value.kind !== "event") throw new Error(`subscribesTo[${index}] must reference an event contract.`);
    if (value.module === id) throw new Error(`Module '${id}' cannot subscribe to its own event.`);
  }
  const ids = [...requires, ...subscribesTo].map((value) => ensureReference(value, "contract").id);
  if (new Set(ids).size !== ids.length) throw new Error(`Module '${id}' declares a duplicate contract reference.`);

  return freeze(
    mark(
      {
        id,
        publicEntrypoints,
        queries,
        commands,
        events,
        dependsOn,
        requires,
        subscribesTo,
      },
      moduleObjects,
    ) as unknown as ModuleDefinition<Queries, Commands, Events>,
  );
}

export type { CommandDraft, EventDraft, QueryDraft };
