/**
 * Standalone Claude Code hook runner. Invoked outside the VS Code extension host
 * as `node hook.js <prompt|tool|stop>`, with the hook event JSON on stdin.
 *
 * It records one checkpoint of the working tree per interaction boundary so the
 * extension can show exactly what the agent changed in its latest request:
 *   - prompt (UserPromptSubmit): snapshot the "before" state, capture the prompt.
 *   - tool   (PostToolUse):      record which file the agent edited.
 *   - stop   (Stop):             snapshot the "after" state, append the interaction.
 *
 * Snapshots are git commit objects kept reachable by refs/acr/head so `git gc`
 * cannot prune them. This file must not import `vscode` — it runs in plain Node.
 */
import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

interface HookInput {
  cwd?: string;
  prompt?: string;
  prompt_id?: string;
  session_id?: string;
  tool_input?: { file_path?: string };
}

interface PendingInteraction {
  id: string;
  prompt: string;
  baseCommit: string;
}

const CHECKPOINT_REF = "refs/acr/head";

function main(): void {
  const event = process.argv[2];
  const input = readInput();
  const cwd = input.cwd || process.cwd();

  const repoRoot = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!repoRoot) {
    return; // Not a git repo; nothing to record.
  }

  const gitDir = tryGit(repoRoot, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir) {
    return;
  }
  const acrDir = path.join(gitDir, "acr");
  fs.mkdirSync(acrDir, { recursive: true });

  const pendingPath = path.join(acrDir, "pending.json");
  const pendingFilesPath = path.join(acrDir, "pending-files");
  const timelinePath = path.join(acrDir, "timeline.jsonl");

  if (event === "prompt") {
    const baseCommit = snapshot(repoRoot, acrDir);
    if (!baseCommit) {
      return;
    }
    const pending: PendingInteraction = {
      id: input.prompt_id || `${input.session_id || "acr"}-${Date.now()}`,
      prompt: (input.prompt || "").trim(),
      baseCommit,
    };
    fs.writeFileSync(pendingPath, JSON.stringify(pending));
    fs.rmSync(pendingFilesPath, { force: true });
    return;
  }

  if (event === "tool") {
    const fp = input.tool_input?.file_path;
    if (!fp || !fs.existsSync(pendingPath)) {
      return;
    }
    const rel = toRepoRelative(repoRoot, fp);
    if (rel) {
      // Append (not rewrite) so parallel tool calls don't clobber each other.
      fs.appendFileSync(pendingFilesPath, rel + "\n");
    }
    return;
  }

  if (event === "stop") {
    if (!fs.existsSync(pendingPath)) {
      return;
    }
    let pending: PendingInteraction;
    try {
      pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
    } catch {
      fs.rmSync(pendingPath, { force: true });
      return;
    }

    const files = readPendingFiles(pendingFilesPath);
    fs.rmSync(pendingPath, { force: true });
    fs.rmSync(pendingFilesPath, { force: true });

    if (files.length === 0) {
      return; // No file edits this turn; nothing to review.
    }

    const resultCommit = snapshot(repoRoot, acrDir);
    if (!resultCommit) {
      return;
    }

    const record = {
      id: pending.id,
      prompt: pending.prompt,
      baseCommit: pending.baseCommit,
      resultCommit,
      files,
      ts: Date.now(),
    };
    fs.appendFileSync(timelinePath, JSON.stringify(record) + "\n");
    return;
  }
}

/**
 * Capture the full working tree as a checkpoint commit and advance refs/acr/head.
 * Uses a throwaway index so the user's real index and working tree are untouched.
 * Returns the commit SHA, or "" on failure.
 */
function snapshot(repoRoot: string, acrDir: string): string {
  const tmpIndex = path.join(
    acrDir,
    `index.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
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
    // Provide an identity so commit-tree works even without a configured user.
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

function readPendingFiles(pendingFilesPath: string): string[] {
  if (!fs.existsSync(pendingFilesPath)) {
    return [];
  }
  const seen = new Set<string>();
  for (const line of fs.readFileSync(pendingFilesPath, "utf8").split("\n")) {
    const rel = line.trim();
    if (rel) {
      seen.add(rel);
    }
  }
  return [...seen];
}

function toRepoRelative(repoRoot: string, filePath: string): string | null {
  // Resolve symlinks on both sides (e.g. macOS /tmp -> /private/tmp) so paths
  // from the hook input line up with git's realpath'd repo root.
  const absRoot = realpathSafe(repoRoot);
  const abs = realpathSafe(
    path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath)
  );
  const rel = path.relative(absRoot, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null; // Outside the repo.
  }
  return rel.split(path.sep).join("/");
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
