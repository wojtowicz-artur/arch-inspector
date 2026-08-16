import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeProject } from "./analyzer.js";
import type { ArchitectureSnapshot } from "./ir.js";

function gitRoot(projectPath: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: projectPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const reason = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`Could not locate a Git repository from '${projectPath}'.${reason}`);
  }
}

/**
 * Analyze a project as it existed at a Git ref without changing the user's worktree.
 * The ref is unpacked into a temporary directory and removed after analysis.
 */
export function analyzeGitRef(ref: string, projectPath: string): ArchitectureSnapshot {
  const absoluteProject = path.resolve(projectPath);
  const repositoryRoot = gitRoot(absoluteProject);
  const projectRelativePath = path.relative(repositoryRoot, absoluteProject);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arch-inspector-git-"));

  try {
    const archive = execFileSync("git", ["archive", ref], {
      cwd: repositoryRoot,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const extracted = spawnSync("tar", ["-xf", "-", "-C", temporaryRoot], {
      input: archive,
      encoding: "utf8",
    });
    if (extracted.status !== 0) {
      throw new Error(extracted.stderr || `Could not extract Git ref '${ref}'.`);
    }
    const extractedProject = projectRelativePath ? path.join(temporaryRoot, projectRelativePath) : temporaryRoot;
    return analyzeProject(extractedProject);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not analyze Git ref '${ref}'. ${reason}`);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
