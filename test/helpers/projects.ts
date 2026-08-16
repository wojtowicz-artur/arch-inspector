import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TemporaryProject {
  root: string;
  cleanup: () => void;
}

interface ProjectOptions {
  files: Record<string, string>;
  include?: string[];
  compilerOptions?: Record<string, unknown>;
  archConfig?: Record<string, unknown>;
}

export function createProject(options: ProjectOptions): TemporaryProject {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arch-inspector-test-"));
  for (const [relativeFile, content] of Object.entries(options.files)) {
    const filePath = path.join(root, relativeFile);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      ...options.compilerOptions,
    },
    include: options.include ?? ["src/**/*.ts"],
  }, null, 2), "utf8");
  if (options.archConfig) {
    fs.writeFileSync(path.join(root, "arch.config.json"), JSON.stringify(options.archConfig, null, 2), "utf8");
  }
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export function createSampleProject(): TemporaryProject {
  return createProject({
    compilerOptions: {
      baseUrl: ".",
      paths: { "@modules/*": ["src/modules/*"] },
    },
    files: {
      "src/modules/booking/index.ts": 'export { reserve } from "./application/reserve";\n',
      "src/modules/booking/application/reserve.ts": 'import type { CalendarSlot } from "../../calendar/internal";\nimport { calendarName } from "../../calendar/internal";\n\nexport function reserve(slot: CalendarSlot): string {\n  return `${calendarName}:${slot.id}`;\n}\n',
      "src/modules/calendar/index.ts": 'export { calendarName } from "./internal";\n',
      "src/modules/calendar/internal.ts": 'import { reserve } from "../booking/application/reserve";\n\nexport type CalendarSlot = { id: string };\nexport const calendarName = reserve ? "calendar" : "calendar";\n',
      "src/modules/admin/index.ts": 'import { reserve } from "@modules/booking";\n\nexport const createBooking = () => reserve({ id: "demo" });\n',
      "src/shared/index.ts": "export const shared = true;\n",
    },
  });
}

export function createScopedProject(): TemporaryProject {
  return createProject({
    include: ["src/**/*.ts", "tests/**/*.ts", ".next/**/*.ts"],
    archConfig: {
      include: ["src/**"],
      exclude: ["src/ignored/**"],
      modules: {
        booking: {
          root: "src/modules/booking",
          publicEntrypoints: ["src/modules/booking/public.ts"],
        },
      },
    },
    files: {
      "src/consumer.ts": 'import { booking } from "./modules/booking/public";\nimport { bookingIsEnabled } from "./modules/booking/internal";\n\nexport const consumer = booking && bookingIsEnabled;\n',
      "src/modules/booking/public.ts": "export const booking = true;\n",
      "src/modules/booking/internal.ts": 'import { booking } from "./public";\nimport "./styles.scss";\n\nexport const bookingIsEnabled = booking;\n',
      "src/ignored/noise.ts": "export const ignored = true;\n",
      "tests/noise.ts": "export const testOnly = true;\n",
      ".next/dev/types/generated.ts": "export const generated = true;\n",
    },
  });
}
