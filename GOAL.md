# GOAL.md

> This file defines the intent of this library.
>
> It exists primarily to keep maintainers and coding agents aligned with the original problem.
> When implementation choices conflict with this document, prefer the goals and constraints described here over local convenience, novelty, architectural fashion, or framework-style expansion.

---

# 1. North Star

Build a **progressive application architecture system for TypeScript** that helps applications remain structurally healthy while their final shape is still unknown.

The library should let a project start simple:

- a small React application,
- a CMS,
- a few business features,
- little or no dependency injection,
- no mandatory ports/adapters,
- no mandatory `Result`,
- no mandatory DTO layers,
- no enterprise ceremony,

while still providing architectural guardrails that make future growth safer.

As complexity increases, the architecture should be able to grow **monotonically**:

```text
simple module
    ↓
explicit public API
    ↓
enforced module boundaries
    ↓
explicit dependencies
    ↓
ports / capabilities where useful
    ↓
typed providers / dependency graph
    ↓
workflows / durable communication where useful
```

Growing the architecture should not require rewriting the application into a different architectural style.

The core promise is:

> **Start simple without giving up the ability to become structured later.**

---

# 2. The Problem We Are Solving

At the beginning of a project, the final form of the application is usually unknown.

A small application may later become:

```text
CMS
├── Blog
├── Booking
├── Marketing
├── Calendar
├── Admin tools
├── Internal workflows
└── External integrations
```

Early in development, creating full Clean Architecture, Hexagonal Architecture, DDD layers, dependency injection containers, ports, adapters, DTOs, mappers, effect systems, or elaborate message buses is often unjustified.

Teams therefore correctly choose simplicity.

The problem is that "keep it simple" often also means:

```text
no explicit boundaries
no dependency rules
no module contracts
no public APIs
no architectural validation
```

When the application grows, these missing guardrails turn into:

- circular dependencies,
- feature internals imported everywhere,
- business rules coupled to React or infrastructure,
- modules that cannot be extracted or tested independently,
- invisible runtime dependencies,
- event buses with unclear control flow,
- accidental coupling to databases, SDKs, or transport,
- expensive architectural rewrites.

The library exists to provide the **smallest useful architectural constraint early**, while allowing stronger mechanisms to be introduced only when justified.

---

# 3. Core Principle: Architecture Must Be Progressive

The library MUST NOT require maximum architectural formality from day one.

A module may begin as:

```text
booking/
  booking.ts
  BookingWidget.tsx
  index.ts
```

That is valid.

Later it may become:

```text
booking/
  domain/
  application/
  infrastructure/
  ui/
  index.ts
```

That is also valid.

The second structure must be an evolution of the first, not a migration to a different framework philosophy.

Architecture is allowed to become more explicit as complexity becomes real.

---

# 4. Core Principle: Modules Are the Primary Unit

The primary architectural unit is the **business module / capability**, not the technical layer.

Prefer:

```text
modules/
  cms/
  blog/
  booking/
  marketing/
```

over organizing the whole application primarily as:

```text
components/
hooks/
services/
utils/
repositories/
```

Technical layers may exist **inside a module** when useful.

Each module should represent a coherent business capability or reason for change.

A module should have:

- a name,
- a boundary,
- a public API,
- optional dependencies on other module APIs,
- optional provided capabilities,
- optional communication contracts,
- optional lifecycle/resources.

Internal implementation structure belongs to the module.

The library should not force every module to use the same internal architecture.

A CRUD-like module may remain simple.

A complex booking or payments module may evolve into domain/application/infrastructure layers.

---

# 5. Core Principle: Boundaries Before Abstractions

The first architectural guardrail should be:

> **Who is allowed to depend on whom?**

This is more important than introducing DI, repositories, DTOs, or effect systems.

The system should make illegal architectural edges visible and preferably machine-verifiable.

Examples:

```text
booking/domain -> react
FORBIDDEN

booking/domain -> booking/infrastructure
FORBIDDEN

blog -> booking/internal/*
FORBIDDEN

blog -> booking/public-api
ALLOWED
```

A project should be able to benefit from these constraints even if it uses:

- plain functions,
- plain promises,
- direct local calls,
- React,
- no container,
- no framework-specific base classes.

---

# 6. Core Principle: Public API Over Deep Imports

Modules communicate through explicit public surfaces.

Code outside a module should not depend on arbitrary internal files.

Prefer:

```ts
import { createBooking } from "@/modules/booking"
```

over:

```ts
import { createBooking } from "@/modules/booking/application/use-cases/create-booking"
```

The library should make public contracts visible and internal implementation replaceable.

Public API does not imply a class, service, interface, or port.

A public API may be as small as one exported function.

---

# 7. Core Principle: Dependency Injection Is a Gradient

Dependency injection is not synonymous with a container.

This is already dependency injection:

```ts
const createBooking = (deps: BookingDeps) => async (input: Input) => {
  // ...
}
```

The library MUST preserve this lightweight style.

Typed ports, tokens, providers, containers, scopes, or lifecycle systems should be available only when they solve a real problem.

The intended progression is:

```text
direct local code
    ↓
function parameters
    ↓
typed dependency object
    ↓
capability / port
    ↓
provider
    ↓
dependency graph
```

Agents MUST NOT introduce a DI container merely because the library is architecture-oriented.

---

# 8. Core Principle: The Dependency Graph Should Become Executable

As the application becomes more formal, the library should be capable of representing architectural facts as data/types rather than documentation only.

Potential graph information includes:

```text
Module A
  provides:
    Booking

  requires:
    Calendar
    Payments

  publishes:
    BookingCreated

  handles:
    CreateBooking
```

From such information, tooling may eventually support:

- missing dependency detection,
- illegal dependency detection,
- cycle detection,
- public API validation,
- graph visualization,
- architecture tests,
- lifecycle ordering,
- module-focused tests,
- deployment planning.

The graph should be useful even if only part of the application uses advanced capabilities.

---

# 9. Core Principle: Communication Semantics Must Be Explicit

Do NOT turn all inter-module communication into events.

Different interactions have different semantics.

The architecture should distinguish at least conceptually between:

## Query

"I need information."

```text
Booking -> Calendar.getAvailability()
```

Expected characteristics:

- request/response,
- no hidden consumers,
- explicit result type.

## Command

"I want another module to attempt an action."

```text
Booking -> Calendar.reserveSlot()
```

Expected characteristics:

- explicit target,
- explicit success/failure,
- visible dependency.

## Event

"A fact has already happened."

```text
BookingCreated
```

Expected characteristics:

- publisher does not need to know consumers,
- zero or many consumers,
- useful for analytics, projections, notifications, integrations.

Events should normally be named in the past tense.

Good:

```text
BookingCreated
SlotReserved
ArticlePublished
```

Suspicious:

```text
CreateBookingRequested
ReserveSlotRequested
```

Those are often commands disguised as events.

## Workflow

"A multi-step process must reach an outcome."

Examples:

```text
reserve slot
    ↓
charge payment
    ↓
create booking
    ↓
send confirmation
```

A workflow may require:

- retries,
- compensation,
- waiting,
- durable execution,
- signals,
- explicit ownership of control flow.

Workflows should not be hidden inside event choreography when ordering and responsibility matter.

## Signal

"Provide information to an already running process."

Useful for:

- approval,
- callback,
- external confirmation,
- long-running processes.

## Stateful Entity / Actor

"Operate on a specific logical owner of state."

Potential examples:

```text
Calendar[userId]
Cart[cartId]
Booking[bookingId]
Document[documentId]
```

This is an advanced capability and MUST NOT be required for ordinary modules.

---

# 10. Core Principle: Local First, Distribution Later

Logical architecture and deployment architecture are different concerns.

A module boundary should be useful even when everything runs:

```text
in one repository
in one JavaScript runtime
in one process
in one deployment
```

The architecture should avoid requiring network semantics for local modules.

At the same time, contracts should be explicit enough that selected boundaries could later be implemented using:

- local function calls,
- local message dispatch,
- worker communication,
- durable invocation,
- RPC,
- another process,
- another deployment,

without redesigning the entire business model.

However:

> The library MUST NOT pretend that a local function call and a network call have identical operational semantics.

Remote/durable communication introduces failure, latency, retries, serialization, versioning, and partial availability.

Those differences must remain explicit.

---

# 11. Core Principle: Boundaries Are More Important Than Uniformity

The architecture of the whole system should be consistent.

The architecture inside every module does NOT need to be identical.

Valid application:

```text
CMS
  simple CRUD

Blog
  simple service layer

Booking
  domain + application + ports

Payments
  workflow + durable integration

Marketing
  React-oriented module
```

This is not architectural inconsistency.

It is **local architecture proportional to local complexity**.

The global rules concern:

- module boundaries,
- public contracts,
- allowed dependencies,
- communication semantics,
- lifecycle ownership.

The library MUST NOT force DDD everywhere.

---

# 12. Core Principle: Boundaries, Schemas and DTOs Are Not the Same Thing

DTOs, schemas and mappers should exist where there is a meaningful boundary.

Examples:

```text
HTTP
database
localStorage
message queue
external API
CMS SDK
worker boundary
process boundary
```

Do not create DTOs and mappers merely because a type crosses a folder.

Internal application/domain data may remain ordinary TypeScript values.

The architecture should encourage explicit serialization boundaries without creating mapping ceremony inside every module.

---

# 13. Core Principle: Errors Should Be Explicit Where They Matter

The library may integrate with `Result`, typed errors, Effect-like systems, or plain exceptions.

It MUST NOT require a single global error philosophy.

A module should be able to begin with:

```ts
async function loadPage() {
  // ordinary TypeScript
}
```

and later expose a more explicit contract:

```ts
Result<Page, PageNotFound | PermissionDenied>
```

when that information is valuable.

Expected business failures benefit from explicit modeling.

Programmer defects do not necessarily need to become domain `Result` values.

Do not force `Result` wrapping around every function.

---

# 14. Architecture Should Be Monotonic

This is one of the most important design properties.

Adding architectural rigor should primarily involve **adding information**, not rewriting working code.

Good evolution:

```text
function
    ↓
exported function
    ↓
module public API
    ↓
explicit deps
    ↓
typed capability
    ↓
provider
```

Bad evolution:

```text
simple app
    ↓
requirements grow
    ↓
rewrite everything into framework-specific classes
```

Agents should ask:

> Can this feature be added by enriching the existing model instead of replacing it?

Prefer additive architecture.

---

# 15. The Library Is Not a Framework That Owns the Application

The library should not become the center of every line of business code.

Business logic should remain ordinary TypeScript whenever possible.

Avoid requiring application code to extend framework classes, use decorators everywhere, or wrap every computation in a proprietary runtime.

The ideal architecture library should often be invisible inside domain logic.

Framework/runtime features belong mainly at:

- composition roots,
- module boundaries,
- infrastructure boundaries,
- lifecycle boundaries,
- communication boundaries.

---

# 16. Non-Goals

The library is NOT trying to become:

## Another NestJS

Do not add decorators, reflection-based magic, controllers, ORM integration, validation systems, routing, logging, configuration, and every other application concern merely because they are convenient.

## Another Effect

Do not turn every computation into a proprietary effect type.

Typed effects may inspire features, but the library should not require users to adopt an effect-system programming model.

## Another Clean Architecture template

Do not force:

```text
Entity
UseCase
RepositoryPort
RepositoryAdapter
DTO
Mapper
Provider
Controller
```

for every feature.

## Another event bus

Inter-module architecture must not collapse into:

```ts
bus.emit(...)
bus.on(...)
```

for every interaction.

## Another microservice framework

The first-class target is a modular application that can run locally as one system.

Distribution is optional and secondary.

## Another code-generation religion

Code generation may be useful, but users should not need a complex compiler pipeline merely to define two local modules.

## A universal business architecture

The library should provide constraints and composition primitives, not decide the domain model for the application.

---

# 17. Anti-Goals for Coding Agents

When implementing this project, DO NOT automatically add:

- ports for every function,
- repositories for every data access,
- DTOs for every type,
- mappers for every object,
- classes when functions are sufficient,
- dependency injection containers before explicit dependencies are needed,
- decorators,
- reflection,
- global service locators,
- event buses for request/response interactions,
- CQRS merely because commands and queries exist,
- event sourcing merely because events exist,
- microservice abstractions,
- distributed systems machinery,
- mandatory `Result`,
- mandatory Effect,
- mandatory RxJS,
- mandatory schema validation inside trusted internal code,
- complex plugin systems before extension requirements are concrete.

Every abstraction must pay for itself.

---

# 18. Design Preference: Explicit Over Magical

Prefer:

```ts
defineModule({
  name: "booking",
  dependsOn: [Calendar]
})
```

over implicit runtime discovery.

Prefer:

```ts
createBooking({ calendar, payments })
```

over invisible service location.

Prefer a visible architecture graph over conventions that only exist in maintainers' heads.

Prefer compile-time validation where TypeScript can express it.

Prefer runtime validation where runtime facts are required.

Do not use type-level tricks solely to demonstrate type-system sophistication.

A complex type is justified only when it produces a clear developer-facing guarantee.

---

# 19. Design Preference: Useful Without Runtime Ownership

Architectural rules should remain useful even without using the full runtime.

For example, a user should ideally be able to use only:

```text
module definitions
+
boundary validation
+
graph tooling
```

while continuing to use their own:

- React setup,
- router,
- server framework,
- database,
- state management,
- error handling.

Advanced runtime features should be composable additions.

---

# 20. Potential Layered Product Model

The project may naturally evolve into layers.

This is guidance, not a required implementation plan.

## Layer 1 — Architecture

```text
defineModule
public API
dependency declarations
boundary rules
graph
cycle detection
```

Should be very lightweight.

## Layer 2 — Capabilities

```text
defineCapability / Port / Token
typed requirements
providers
composition
```

Optional.

## Layer 3 — Communication

```text
query
command
event
workflow
signal
```

Optional and semantically explicit.

## Layer 4 — Runtime

```text
lifecycle
resource scopes
startup/shutdown
durability
local/remote adapters
```

Optional.

A user should not need Layer 4 to benefit from Layer 1.

---

# 21. Example of the Desired Developer Experience

Day 1:

```ts
export const Booking = defineModule({
  name: "booking"
})
```

No provider graph.
No ports.
No event bus.

Later:

```ts
export const Booking = defineModule({
  name: "booking",
  dependsOn: [Calendar]
})
```

Later:

```ts
export const Booking = defineModule({
  name: "booking",

  requires: [
    Calendar.commands.reserveSlot,
    Payments.commands.charge
  ],

  publishes: [
    BookingCreated
  ]
})
```

Later, if justified:

```ts
export const Booking = defineModule({
  name: "booking",

  requires: [
    Calendar.commands.reserveSlot,
    Payments.commands.charge
  ],

  workflows: [
    CompleteBooking
  ],

  providers: [
    BookingRepositoryLive
  ],

  publishes: [
    BookingCreated
  ]
})
```

The earlier versions were not mistakes.

They were valid earlier stages of the same architecture.

---

# 22. Success Criteria

The library is succeeding if:

### Small projects stay small

A 20-file application does not feel like an enterprise system.

### Architectural mistakes become visible early

Illegal dependencies, cycles, and accidental deep imports can be detected automatically.

### Modules remain understandable

A developer can answer:

```text
What does this module provide?
What does it depend on?
How may other modules talk to it?
What may it publish?
```

without reading the entire repository.

### Complexity can remain local

A complicated booking module does not force the CMS module to adopt the same architecture.

### Growth does not require a rewrite

A local module can gain stronger contracts, capabilities, workflows, or infrastructure without changing the entire programming model.

### Deployment remains a separate concern

The same logical module structure can support a monolith today and selective distribution later.

### The architecture can be inspected by tools

Humans and agents can derive a meaningful graph from the project.

---

# 23. Decision Filter for Every New Feature

Before adding a feature, maintainers and agents MUST ask:

1. **Which concrete problem does this solve?**
2. **Does that problem belong to architecture, or to another library/framework?**
3. **Can a user ignore this feature until they actually need it?**
4. **Does this preserve the progressive adoption model?**
5. **Does it make architectural information more explicit?**
6. **Does it reduce or increase hidden coupling?**
7. **Can this be implemented without forcing a new programming model on existing modules?**
8. **Does it preserve local-first usage?**
9. **Are we introducing abstraction because of observed complexity, or anticipated complexity?**
10. **Would the project still make sense if this feature were removed?**

If a feature causes ordinary modules to require substantially more ceremony, the burden of proof is on the feature.

---

# 24. Agent Alignment Rules

Coding agents working on this repository should treat this file as a higher-level design constraint.

Before significant architectural changes:

1. Read `GOAL.md`.
2. Identify which stated goal the change advances.
3. Identify which non-goals or anti-goals could be violated.
4. Prefer the smallest implementation that advances the goal.
5. Do not introduce a new subsystem merely because it is elegant in isolation.
6. Do not refactor unrelated simple code into a new abstraction for consistency.
7. Preserve existing simple usage paths.
8. Keep advanced features opt-in.
9. Keep module boundaries and communication semantics explicit.
10. If a proposed change moves the project toward being a general application framework, reconsider it.

When uncertain between:

```text
more power
```

and:

```text
less ceremony + clear architectural guarantees
```

prefer the second unless the additional power directly supports the North Star.

---

# 25. The Short Version

If an agent remembers only this section, remember:

> **This library exists to let TypeScript applications start simple and grow into well-structured modular systems without an architectural rewrite.**

Therefore:

```text
modules before layers
boundaries before abstractions
public APIs before deep imports
plain DI before containers
commands/queries/events by semantics
workflows when orchestration is real
local before distributed
opt-in complexity
machine-verifiable architecture
no ceremony without demonstrated value
```

The goal is not maximal architecture.

The goal is **the minimum architecture that preserves future options**.
