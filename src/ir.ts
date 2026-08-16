export const IR_VERSION = "0.1" as const;

export type Resolution = "internal" | "external" | "asset" | "unresolved";
export type ImportKind = "static" | "export" | "dynamic" | "require";
export type DiagnosticLevel = "error" | "warning" | "info";
export type DiagnosticCategory = "violation" | "observation";

export interface ArchitectureFile {
  path: string;
  moduleId: string;
  language: "typescript" | "javascript";
  lines: number;
}

export interface ArchitectureModule {
  id: string;
  kind: "inferred";
  root: string;
  files: string[];
  entrypoints: string[];
}

export interface ArchitectureEdge {
  id: string;
  fromFile: string;
  toFile?: string;
  fromModule: string;
  toModule?: string;
  specifier: string;
  importKind: ImportKind;
  resolution: Resolution;
  typeOnly: boolean;
  publicApi: boolean;
  location: {
    line: number;
    column: number;
  };
}

export interface ModuleEdge {
  from: string;
  to: string;
  imports: number;
  publicApiImports: number;
  files: string[];
}

export interface ArchitectureDiagnostic {
  code: string;
  category: DiagnosticCategory;
  level: DiagnosticLevel;
  message: string;
  file?: string;
  line?: number;
  related?: string[];
  data?: Record<string, unknown>;
}

export interface ArchitectureMetrics {
  sourceFiles: number;
  modules: number;
  imports: number;
  internalImports: number;
  externalImports: number;
  assetImports: number;
  unresolvedImports: number;
  moduleEdges: number;
  cycles: number;
  deepImports: number;
  maxFanIn: { module: string; value: number } | null;
  maxFanOut: { module: string; value: number } | null;
}

export interface ArchitectureSnapshot {
  irVersion: typeof IR_VERSION;
  project: {
    root: string;
    tsconfig: string;
    sourceRoot: string;
  };
  modules: ArchitectureModule[];
  files: ArchitectureFile[];
  edges: ArchitectureEdge[];
  moduleEdges: ModuleEdge[];
  cycles: string[][];
  metrics: ArchitectureMetrics;
  diagnostics: ArchitectureDiagnostic[];
}
