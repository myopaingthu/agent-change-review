/**
 * Standalone Claude Code hook runner. Invoked outside the VS Code extension host
 * as `node hook.js <prompt|pre|tool|stop>`, with the hook event JSON on stdin.
 *
 * Records one checkpoint per repo per interaction so the extension can show what
 * the agent changed in its latest request:
 *   - prompt (UserPromptSubmit): start an interaction, capture the prompt.
 *   - pre    (PreToolUse):       first time a repo is touched, snapshot it *before* the edit.
 *   - tool   (PostToolUse):      record which file (and repo) the agent edited.
 *   - stop   (Stop):             snapshot each touched repo, append one record per repo.
 *
 * The repo is derived from each edited file's path, never from Claude's cwd —
 * cwd may not be a repo at all (e.g. a workspace folder holding backend/ and
 * frontend/), and a single request can span several repos.
 *
 * Snapshots are git commits kept reachable by refs/acr/head so `git gc` cannot
 * prune them. This file must not import anything but Node built-ins: it is
 * copied on its own to ~/.claude/acr/hook.js.
 */
import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface HookInput {
  cwd?: string;
  prompt?: string;
  prompt_id?: string;
  session_id?: string;
  tool_input?: { file_path?: string };
}

interface BaseEntry {
  repo: string;
  base: string;
}
interface FileEntry {
  repo: string;
  file: string;
}

const CHECKPOINT_REF = "refs/acr/head";

function main(): void {
  const event = process.argv[2];
  const input = readInput();
  const sessionId = sanitize(input.session_id || "default");
  const dir = path.join(os.homedir(), ".claude", "acr", "pending", sessionId);
  const metaPath = path.join(dir, "meta.json");
  const basesPath = path.join(dir, "bases.jsonl");
  const filesPath = path.join(dir, "files.jsonl");

  if (event === "prompt") {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        id: input.prompt_id || `${sessionId}-${Date.now()}`,
        prompt: (input.prompt || "").trim(),
      })
    );
    return;
  }

  if (event === "pre") {
    if (!fs.existsSync(metaPath)) {
      return;
    }
    const repo = repoOf(input.tool_input?.file_path);
    if (!repo) {
      return;
    }
    // Keep the first base per repo: it predates every edit this interaction made
    // to that repo.
    if (readJsonl<BaseEntry>(basesPath).some((b) => b.repo === repo)) {
      return;
    }
    const base = snapshot(repo);
    if (base) {
      appendJsonl(basesPath, { repo, base });
    }
    return;
  }

  if (event === "tool") {
    if (!fs.existsSync(metaPath)) {
      return;
    }
    const filePath = input.tool_input?.file_path;
    const repo = repoOf(filePath);
    if (!repo || !filePath) {
      return;
    }
    const rel = toRepoRelative(repo, filePath);
    if (rel) {
      // Append rather than rewrite so parallel tool calls can't clobber.
      appendJsonl(filesPath, { repo, file: rel });
    }
    return;
  }

  if (event === "stop") {
    if (!fs.existsSync(metaPath)) {
      return;
    }
    let meta: { id: string; prompt: string };
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }

    const bases = readJsonl<BaseEntry>(basesPath);
    const filesByRepo = new Map<string, Set<string>>();
    for (const entry of readJsonl<FileEntry>(filesPath)) {
      let set = filesByRepo.get(entry.repo);
      if (!set) {
        set = new Set();
        filesByRepo.set(entry.repo, set);
      }
      set.add(entry.file);
    }

    // One timestamp for the whole interaction so its per-repo records group.
    const ts = Date.now();
    for (const [repo, fileSet] of filesByRepo) {
      const baseEntry = bases.find((b) => b.repo === repo);
      if (!baseEntry) {
        continue; // No pre-edit baseline for this repo; can't diff it safely.
      }
      const resultCommit = snapshot(repo);
      if (!resultCommit) {
        continue;
      }
      const acr = acrDir(repo);
      if (!acr) {
        continue;
      }
      const record = {
        id: meta.id,
        prompt: meta.prompt,
        baseCommit: baseEntry.base,
        resultCommit,
        files: [...fileSet],
        ts,
      };
      fs.appendFileSync(
        path.join(acr, "timeline.jsonl"),
        JSON.stringify(record) + "\n"
      );
    }

    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
}

/**
 * The repo containing `filePath`, or null. Resolves from the file's nearest
 * existing directory, so files the agent is about to create still resolve.
 */
function repoOf(filePath?: string): string | null {
  if (!filePath) {
    return null;
  }
  let dir = path.dirname(path.resolve(filePath));
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
  const root = tryGit(dir, ["rev-parse", "--show-toplevel"]);
  return root ? realpathSafe(root) : null;
}

function acrDir(repoRoot: string): string | null {
  const gitDir = tryGit(repoRoot, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir) {
    return null;
  }
  const dir = path.join(gitDir, "acr");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Capture a repo's full working tree as a checkpoint commit and advance
 * refs/acr/head. Uses a throwaway index so the real index and working tree are
 * untouched. Returns the commit SHA, or "" on failure.
 */
function snapshot(repoRoot: string): string {
  const tmpIndex = path.join(
    os.tmpdir(),
    `acr-index-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
  );
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    // Seed from HEAD when it exists so deletions are recorded; harmless if not.
    tryGit(repoRoot, ["read-tree", "HEAD"], env);
    if (tryGit(repoRoot, ["add", "-A"], env) === null) {
      return "";
    }
    const tree = tryGit(repoRoot, ["write-tree"], env);
    if (!tree) {
      return "";
    }
    const parent = tryGit(repoRoot, ["rev-parse", "--verify", "-q", CHECKPOINT_REF]);
    const commitArgs = ["commit-tree", tree];
    if (parent) {
      commitArgs.push("-p", parent);
    }
    commitArgs.push("-m", "acr checkpoint");
    // Provide an identity so commit-tree works without a configured git user.
    const identityEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Agent Change Review",
      GIT_AUTHOR_EMAIL: "acr@local",
      GIT_COMMITTER_NAME: "Agent Change Review",
      GIT_COMMITTER_EMAIL: "acr@local",
    };
    const commit = tryGit(repoRoot, commitArgs, identityEnv);
    if (!commit) {
      return "";
    }
    if (tryGit(repoRoot, ["update-ref", CHECKPOINT_REF, commit]) === null) {
      return "";
    }
    return commit;
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

function toRepoRelative(repoRoot: string, filePath: string): string | null {
  // Resolve symlinks on both sides (e.g. macOS /tmp -> /private/tmp) so paths
  // from the hook input line up with git's realpath'd repo root.
  const abs = realpathSafe(path.resolve(filePath));
  const rel = path.relative(repoRoot, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join("/");
}

function readJsonl<T>(filePath: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip a torn line rather than dropping the interaction.
    }
  }
  return out;
}

function appendJsonl(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(value) + "\n");
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** realpath that tolerates a not-yet/deleted file by resolving its directory. */
function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return path.resolve(p);
    }
  }
}

function readInput(): HookInput {
  try {
    const raw = fs.readFileSync(0, "utf8");
    return raw ? (JSON.parse(raw) as HookInput) : {};
  } catch {
    return {};
  }
}

/** Run git and return trimmed stdout, or null on failure (never throws). */
function tryGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return null;
  }
}

try {
  main();
} catch {
  // Never fail the hook — a crashing hook must not disrupt the agent.
} finally {
  process.exit(0);
}
