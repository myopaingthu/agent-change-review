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
export function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
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

async function hasHead(repoRoot: string): Promise<boolean> {
  try {
    await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return all changed files in the working tree relative to HEAD, plus untracked
 * files. Combines staged and unstaged changes so agent edits are always shown.
 */
export async function getChangedFiles(repoRoot: string): Promise<ChangedFile[]> {
  const head = await hasHead(repoRoot);
  const diffArgs = ["--no-ext-diff", "--unified=3", "-M"];
  const trackedDiff = head
    ? await runGit(repoRoot, ["diff", "HEAD", ...diffArgs])
    : await runGit(repoRoot, ["diff", "--cached", ...diffArgs]);

  const tracked = parseDiff(trackedDiff);
  const seen = new Set(tracked.map((f) => f.path));

  const untracked = await getUntrackedFiles(repoRoot);
  const untrackedFiles: ChangedFile[] = [];
  for (const rel of untracked) {
    if (seen.has(rel)) {
      continue;
    }
    untrackedFiles.push(await buildUntrackedFile(repoRoot, rel));
  }

  return [...tracked, ...untrackedFiles].sort((a, b) => a.path.localeCompare(b.path));
}

async function getUntrackedFiles(repoRoot: string): Promise<string[]> {
  const out = await runGit(repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

async function buildUntrackedFile(repoRoot: string, rel: string): Promise<ChangedFile> {
  const abs = path.join(repoRoot, rel);
  let content = "";
  let binary = false;
  try {
    const buf = await fs.promises.readFile(abs);
    binary = buf.includes(0);
    if (!binary) {
      content = buf.toString("utf8");
    }
  } catch {
    // File may have been removed between listing and reading.
  }

  let diff = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n`;
  const hunks: ChangedFile["hunks"] = [];

  if (binary) {
    diff += "Binary files /dev/null and b/" + rel + " differ\n";
  } else if (content.length) {
    const lines = content.split("\n");
    // A trailing newline produces a final empty element; drop it for counting.
    const hasTrailingNewline = content.endsWith("\n");
    const bodyLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
    const count = bodyLines.length;
    const header = `@@ -0,0 +1,${count} @@`;
    const hunkLines = [header, ...bodyLines.map((l) => `+${l}`)];
    if (!hasTrailingNewline) {
      hunkLines.push("\\ No newline at end of file");
    }
    diff += hunkLines.join("\n") + "\n";
    hunks.push({
      header,
      lines: hunkLines,
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: count,
    });
  }

  return {
    path: rel,
    status: "untracked",
    diff,
    hunks,
    binary,
    untracked: true,
  };
}

/**
 * Reject a file: revert it to its HEAD state (for tracked files) or delete it
 * (for new/untracked files).
 */
export async function rejectFile(repoRoot: string, file: ChangedFile): Promise<void> {
  const abs = path.join(repoRoot, file.path);

  if (file.untracked) {
    await fs.promises.rm(abs, { force: true });
    return;
  }

  switch (file.status) {
    case "added":
      // Staged new file: unstage then remove from disk.
      await runGit(repoRoot, ["restore", "--staged", "--", file.path]).catch(() => undefined);
      await fs.promises.rm(abs, { force: true });
      break;
    case "renamed":
      // Restore the original path from HEAD and drop the renamed copy.
      if (file.oldPath) {
        await runGit(repoRoot, ["checkout", "HEAD", "--", file.oldPath]);
      }
      await runGit(repoRoot, ["restore", "--staged", "--", file.path]).catch(() => undefined);
      await fs.promises.rm(abs, { force: true });
      break;
    default:
      // modified or deleted: restore index and working tree from HEAD.
      await runGit(repoRoot, ["checkout", "HEAD", "--", file.path]);
      break;
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
