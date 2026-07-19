import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChangedFile, Hunk } from "./types";
import { buildFilePatch, buildHunkPatch } from "./diffParser";

export class GitError extends Error {
  constructor(message: string, public readonly stderr?: string) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * A patch could not be reverse-applied, because the file no longer contains what
 * the patch expects — typically the user edited the same lines the agent did.
 * Distinct from GitError so callers can offer to restore the file instead.
 */
export class PatchConflictError extends GitError {
  constructor(stderr?: string) {
    super("patch does not apply", stderr);
    this.name = "PatchConflictError";
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
  files: string[],
  context = 3
): Promise<string> {
  const args = ["diff", "--no-ext-diff", `--unified=${context}`, "-M", base, result];
  if (files.length) {
    args.push("--", ...files);
  }
  return runGit(repoRoot, args);
}

/**
 * Which of `files` differ between two tree-ish revisions. Used as a yes/no
 * filter only — never to build diff text — so that live working-tree state can
 * decide whether a file still needs reviewing without leaking into the review.
 *
 * `--no-renames` keeps the reported paths aligned with the caller's file list,
 * which comes from individual tool calls rather than from git.
 */
export async function changedPaths(
  repoRoot: string,
  a: string,
  b: string,
  files: string[]
): Promise<Set<string>> {
  const args = ["diff", "--no-ext-diff", "--name-only", "--no-renames", a, b];
  if (files.length) {
    args.push("--", ...files);
  }
  const out = await runGit(repoRoot, args);
  return new Set(
    out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  );
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
 * Undo a patch in the working tree by reverse-applying it. Only the lines the
 * patch describes are touched, so unrelated edits in the same file survive.
 * Throws PatchConflictError when the patch no longer applies.
 */
export async function applyPatchReverse(
  repoRoot: string,
  patchText: string
): Promise<void> {
  const tmp = path.join(
    os.tmpdir(),
    `acr-patch-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`
  );
  await fs.promises.writeFile(tmp, patchText, "utf8");
  try {
    await runGit(repoRoot, [
      "apply",
      "--reverse",
      "--recount",
      "--whitespace=nowarn",
      tmp,
    ]);
  } catch (err) {
    throw new PatchConflictError(err instanceof GitError ? err.stderr : undefined);
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

/** Reject a single hunk by reverse-applying just that hunk to the working tree. */
export async function rejectHunk(
  repoRoot: string,
  file: ChangedFile,
  hunk: Hunk
): Promise<void> {
  await applyPatchReverse(repoRoot, buildHunkPatch(file, hunk));
}

/**
 * Reject a file's change by reverse-applying its hunks. Defaults to all of them;
 * pass a subset to skip hunks already rejected on their own, which would
 * otherwise make the whole patch fail to apply.
 */
export async function rejectFilePatch(
  repoRoot: string,
  file: ChangedFile,
  hunks: Hunk[] = file.hunks
): Promise<void> {
  await applyPatchReverse(repoRoot, buildFilePatch(file, hunks));
}
