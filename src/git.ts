import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChangedFile, Hunk } from "./types";
import { buildHunkPatch, parseDiff } from "./diffParser";

export class GitError extends Error {
  constructor(message: string, public readonly stderr?: string) {
    super(message);
    this.name = "GitError";
  }
}

/** Run a git command in `cwd` and return stdout. Rejects with GitError on failure. */
export function runGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env },
      (error, stdout, stderr) => {
        if (error) {
          reject(new GitError(`git ${args.join(" ")} failed`, stderr || error.message));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/** Return the absolute repo root that contains `cwd`, or null if not a git repo. */
export async function getRepoRoot(cwd: string): Promise<string | null> {
  try {
    const out = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Return the absolute path to the repo's git directory (usually `<repo>/.git`). */
export async function getGitDir(repoRoot: string): Promise<string> {
  const out = await runGit(repoRoot, ["rev-parse", "--absolute-git-dir"]);
  return out.trim();
}

/** Initialize a new git repository in `cwd`. Required before any review works. */
export async function gitInit(cwd: string): Promise<void> {
  await runGit(cwd, ["init"]);
}

/**
 * Write the current working tree to a tree object and return its SHA, without
 * touching the real index. Diffing a checkpoint against this (rather than the
 * recorded result commit) keeps the review live: rejected files drop out, and
 * files the agent created still show, since `add -A` stages untracked files.
 */
export async function snapshotTree(repoRoot: string): Promise<string> {
  const tmpIndex = path.join(
    os.tmpdir(),
    `acr-view-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    // Seed from HEAD when it exists so deletions register; harmless if not.
    await runGit(repoRoot, ["read-tree", "HEAD"], env).catch(() => undefined);
    await runGit(repoRoot, ["add", "-A"], env);
    return (await runGit(repoRoot, ["write-tree"], env)).trim();
  } finally {
    await fs.promises.rm(tmpIndex, { force: true });
  }
}

/**
 * Diff two commits, restricted to the given paths. Used by timeline mode to show
 * exactly what an interaction changed (base -> result, scoped to agent files).
 */
export async function diffCommits(
  repoRoot: string,
  base: string,
  result: string,
  files: string[]
): Promise<string> {
  const args = ["diff", "--no-ext-diff", "--unified=3", "-M", base, result];
  if (files.length) {
    args.push("--", ...files);
  }
  return runGit(repoRoot, args);
}

/** Restore a single path in the working tree (and index) to its state in `commit`. */
export async function restorePathFromCommit(
  repoRoot: string,
  commit: string,
  filePath: string
): Promise<void> {
  await runGit(repoRoot, ["checkout", commit, "--", filePath]);
}

/** Whether `filePath` exists in `commit` (i.e. the file predates this interaction). */
export async function pathExistsInCommit(
  repoRoot: string,
  commit: string,
  filePath: string
): Promise<boolean> {
  try {
    await runGit(repoRoot, ["cat-file", "-e", `${commit}:${filePath}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reject a single hunk by reverse-applying it to the working tree. Throws a
 * GitError if the patch no longer applies (e.g. the file changed while
 * reviewing).
 */
export async function rejectHunk(
  repoRoot: string,
  file: ChangedFile,
  hunk: Hunk
): Promise<void> {
  const patch = buildHunkPatch(file, hunk);
  const tmp = path.join(
    os.tmpdir(),
    `acr-hunk-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`
  );
  await fs.promises.writeFile(tmp, patch, "utf8");
  try {
    await runGit(repoRoot, [
      "apply",
      "--reverse",
      "--recount",
      "--whitespace=nowarn",
      tmp,
    ]);
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}
