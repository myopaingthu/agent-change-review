import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getRepoRoot } from "./git";

/**
 * Finds every Git repository in the workspace. A workspace can hold several
 * (e.g. a folder holding `backend/` and `frontend/`, or a multi-root workspace),
 * and a single agent request can touch more than one of them.
 */

/** Directories never worth descending into when looking for repos. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "target",
  "vendor",
]);

/** How many levels below a workspace folder to look for nested repos. */
const SCAN_DEPTH = 2;

const CACHE_MS = 10_000;
let cache: { ts: number; repos: string[] } | undefined;

/** Drop the cached repo list (after `git init`, or when folders change). */
export function invalidateRepoCache(): void {
  cache = undefined;
}

/** All Git repos inside the workspace, as deduped realpaths. */
export async function discoverRepos(): Promise<string[]> {
  if (cache && Date.now() - cache.ts < CACHE_MS) {
    return cache.repos;
  }
  const repos = await discoverReposUncached();
  cache = { ts: Date.now(), repos };
  return repos;
}

async function discoverReposUncached(): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    return [];
  }
  const workspaceRoots = folders.map((f) => realpathSafe(f.uri.fsPath));
  const found = new Set<string>();

  // Reuse VS Code's own repository discovery so we see what Source Control sees.
  const api = await getGitApi();
  if (api) {
    for (const repo of api.repositories) {
      try {
        const root = realpathSafe(repo.rootUri.fsPath);
        if (workspaceRoots.some((w) => isWithin(root, w))) {
          found.add(root);
        }
      } catch {
        // Ignore a malformed repository entry.
      }
    }
  }

  // Union with our own shallow scan: covers a disabled git extension and
  // narrowed `git.autoRepositoryDetection` settings.
  for (const folder of folders) {
    const own = await getRepoRoot(folder.uri.fsPath).catch(() => null);
    if (own) {
      found.add(realpathSafe(own));
    }
    await scanForRepos(folder.uri.fsPath, SCAN_DEPTH, found);
  }

  return [...found].sort();
}

async function scanForRepos(
  dir: string,
  depth: number,
  acc: Set<string>
): Promise<void> {
  if (depth < 0) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const child = path.join(dir, entry.name);
    if (await exists(path.join(child, ".git"))) {
      acc.add(realpathSafe(child));
      continue; // A repo's own subdirectories are part of that repo.
    }
    await scanForRepos(child, depth - 1, acc);
  }
}

interface GitRepositoryLike {
  rootUri: vscode.Uri;
}
interface GitApiLike {
  repositories: GitRepositoryLike[];
}
interface GitExtensionLike {
  getAPI(version: 1): GitApiLike;
}

async function getGitApi(): Promise<GitApiLike | undefined> {
  try {
    const ext = vscode.extensions.getExtension<GitExtensionLike>("vscode.git");
    if (!ext) {
      return undefined;
    }
    if (!ext.isActive) {
      await ext.activate();
    }
    return ext.exports.getAPI(1);
  } catch {
    return undefined; // Git extension disabled or API unavailable.
  }
}

/** True when `p` is `parent` or lives inside it. */
export function isWithin(p: string, parent: string): boolean {
  const rel = path.relative(parent, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** realpath that tolerates a missing path, so symlinked roots still compare. */
function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
