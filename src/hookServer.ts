/**
 * Receives Claude Code's hook events over loopback HTTP and records one
 * checkpoint per repo per interaction, so the panel can show what the agent
 * changed in its latest request:
 *   - prompt (UserPromptSubmit): start an interaction, capture the prompt.
 *   - pre    (PreToolUse):       first time a repo is touched, snapshot it *before* the edit.
 *   - tool   (PostToolUse):      record which file (and repo) the agent edited.
 *   - stop   (Stop):             snapshot each touched repo, append one record per repo.
 *
 * HTTP rather than a spawned script: Claude Code issues the request itself, so
 * nothing has to be installed on the user's machine to run it. PreToolUse still
 * blocks the tool call until this answers, which is what keeps the "before"
 * baseline exact rather than a race against the agent's first write.
 *
 * The repo is derived from each edited file's path, never from Claude's cwd —
 * cwd may not be a repo at all (e.g. a folder holding backend/ and frontend/),
 * and a single request can span several repos.
 */
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { getRepoRoot, writeCheckpoint } from "./git";
import { getAcrDir } from "./timeline";
import { InteractionRecord } from "./types";

/** Stable so the URL written into Claude Code's settings survives a restart. */
const DEFAULT_PORT = 51797;
const URL_PREFIX = "/agent-change-review";
const HEALTH_MARKER = '{"agentChangeReview":true}';
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 700;
/** How often a sharing window checks whether the owner has gone away. */
const TAKEOVER_INTERVAL_MS = 5000;

interface HookInput {
  session_id?: string;
  prompt?: string;
  prompt_id?: string;
  tool_input?: { file_path?: string };
}

/** An interaction being assembled, between UserPromptSubmit and Stop. */
interface Pending {
  id: string;
  prompt: string;
  /** repo root -> checkpoint taken before the agent first edited that repo. */
  bases: Map<string, string>;
  /** repo root -> repo-relative paths the agent edited. */
  files: Map<string, Set<string>>;
}

export class HookServer {
  private server: http.Server | undefined;
  private token = "";
  private port = 0;
  /** False when another window already serves the port and we only share its URL. */
  private owned = false;
  private pending = new Map<string, Pending>();
  /** Set only while sharing another window's port, to notice it closing. */
  private takeover: NodeJS.Timeout | undefined;
  /**
   * Serializes event handling. Two PreToolUse events racing on one repo would
   * otherwise both see "no baseline yet" and both snapshot, and the second would
   * already contain the first edit.
   */
  private queue: Promise<unknown> = Promise.resolve();

  /** The prefix Claude Code posts to, or undefined until start() succeeds. */
  public get baseUrl(): string | undefined {
    return this.port ? `http://127.0.0.1:${this.port}${URL_PREFIX}/${this.token}` : undefined;
  }

  /**
   * Bind the receiver. Prefers the fixed port so the stored URL stays valid; if
   * another window of ours already holds it, share that URL instead of binding a
   * second server. Only an unrelated process on the port forces a new one.
   */
  public async start(token: string): Promise<void> {
    this.token = token;

    const fixed = await this.bind(DEFAULT_PORT);
    if (fixed !== null) {
      this.port = fixed;
      this.owned = true;
      return;
    }

    if (await probeOurs(DEFAULT_PORT, token)) {
      // Another window of ours already serves this address. Share it rather than
      // binding a second server, but watch for that window closing.
      this.port = DEFAULT_PORT;
      this.owned = false;
      this.watchForTakeover();
      return;
    }

    const ephemeral = await this.bind(0);
    if (ephemeral !== null) {
      this.port = ephemeral;
      this.owned = true;
    }
  }

  /**
   * Claim the fixed port once the window that held it goes away. Without this,
   * closing whichever window happened to bind first would leave the others
   * pointing at an address nobody answers — recording would stop with no sign.
   */
  private watchForTakeover(): void {
    if (this.takeover) {
      return;
    }
    this.takeover = setInterval(() => {
      void (async () => {
        if (this.owned || await probeOurs(DEFAULT_PORT, this.token)) {
          return;
        }
        const bound = await this.bind(DEFAULT_PORT);
        if (bound !== null) {
          this.port = bound;
          this.owned = true;
          this.stopWatching();
        }
      })();
    }, TAKEOVER_INTERVAL_MS);
    // Never hold the host process open just for this.
    this.takeover.unref?.();
  }

  private stopWatching(): void {
    if (this.takeover) {
      clearInterval(this.takeover);
      this.takeover = undefined;
    }
  }

  private bind(port: number): Promise<number | null> {
    const server = http.createServer((req, res) => void this.handle(req, res));
    return new Promise((resolve) => {
      const onError = () => {
        server.removeListener("listening", onListening);
        resolve(null);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        // Past this point a socket-level error must not reach the extension
        // host as an unhandled 'error' event.
        server.on("error", () => undefined);
        const address = server.address();
        if (typeof address === "object" && address) {
          this.server = server;
          resolve(address.port);
          return;
        }
        server.close();
        resolve(null);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // A browser always sends Origin on a cross-origin fetch and Claude Code never
    // does, so requiring its absence blocks the DNS-rebinding path to loopback.
    if (req.headers.origin) {
      res.writeHead(403).end();
      return;
    }

    const slug = this.routeOf(req.url);
    if (!slug) {
      res.writeHead(404).end();
      return;
    }

    if (slug === "health") {
      res.writeHead(200, { "content-type": "application/json" }).end(HEALTH_MARKER);
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    let input: HookInput;
    try {
      input = JSON.parse(await readBody(req)) as HookInput;
    } catch {
      res.writeHead(400).end();
      return;
    }

    // Always answer 204, even on failure: a bug in here must never block the
    // user's tool call or surface as a hook error mid-conversation.
    try {
      await this.serialize(() => this.record(slug, input));
    } catch {
      // Recording is best-effort; the panel simply won't show this request.
    }
    res.writeHead(204).end();
  }

  /** The trailing segment of `/agent-change-review/<token>/<slug>`, if the token matches. */
  private routeOf(url: string | undefined): string | null {
    if (!url || !this.token) {
      return null;
    }
    const expected = `${URL_PREFIX}/${this.token}/`;
    const pathname = url.split("?")[0];
    if (!pathname.startsWith(expected)) {
      return null;
    }
    const slug = pathname.slice(expected.length);
    return /^[a-z]+$/.test(slug) ? slug : null;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async record(slug: string, input: HookInput): Promise<void> {
    const sessionId = input.session_id || "default";

    if (slug === "prompt") {
      this.pending.set(sessionId, {
        id: input.prompt_id || `${sessionId}-${Date.now()}`,
        prompt: (input.prompt || "").trim(),
        bases: new Map(),
        files: new Map(),
      });
      return;
    }

    const pending = this.pending.get(sessionId);
    if (!pending) {
      return; // No interaction in flight (hook installed mid-session).
    }

    if (slug === "pre") {
      const repo = await repoOf(input.tool_input?.file_path);
      // Keep the first base per repo: it predates every edit this interaction
      // made to that repo.
      if (!repo || pending.bases.has(repo)) {
        return;
      }
      try {
        pending.bases.set(repo, await writeCheckpoint(repo));
      } catch {
        // No baseline for this repo, so stop() will skip it rather than diff
        // against something that already contains the agent's work.
      }
      return;
    }

    if (slug === "tool") {
      const filePath = input.tool_input?.file_path;
      const repo = await repoOf(filePath);
      if (!repo || !filePath) {
        return;
      }
      const rel = toRepoRelative(repo, filePath);
      if (!rel) {
        return;
      }
      let touched = pending.files.get(repo);
      if (!touched) {
        touched = new Set();
        pending.files.set(repo, touched);
      }
      touched.add(rel);
      return;
    }

    if (slug === "stop") {
      this.pending.delete(sessionId);
      // One timestamp for the whole interaction so its per-repo records group.
      const ts = Date.now();
      for (const [repo, touched] of pending.files) {
        const baseCommit = pending.bases.get(repo);
        if (!baseCommit) {
          continue; // No pre-edit baseline for this repo; can't diff it safely.
        }
        try {
          const resultCommit = await writeCheckpoint(repo);
          const dir = await getAcrDir(repo);
          await fs.promises.mkdir(dir, { recursive: true });
          const record: InteractionRecord = {
            id: pending.id,
            prompt: pending.prompt,
            baseCommit,
            resultCommit,
            files: [...touched],
            ts,
          };
          await fs.promises.appendFile(
            path.join(dir, "timeline.jsonl"),
            JSON.stringify(record) + "\n"
          );
        } catch {
          continue; // Repo may have gone away; record the rest.
        }
      }
    }
  }

  public dispose(): void {
    this.stopWatching();
    this.pending.clear();
    if (this.owned) {
      this.server?.close();
    }
    this.server = undefined;
    this.port = 0;
  }
}

/** Whether the process already on `port` is another window of this extension. */
function probeOurs(port: number, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: `${URL_PREFIX}/${token}/health`,
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve(res.statusCode === 200 && body.includes(HEALTH_MARKER)));
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("hook payload too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * The repo containing `filePath`, or null. Resolves from the file's nearest
 * existing directory, so files the agent is about to create still resolve.
 */
async function repoOf(filePath?: string): Promise<string | null> {
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
  const root = await getRepoRoot(dir);
  return root ? realpathSafe(root) : null;
}

function toRepoRelative(repoRoot: string, filePath: string): string | null {
  // Resolve symlinks on both sides (e.g. macOS /tmp -> /private/tmp) so paths
  // from the hook payload line up with git's realpath'd repo root.
  const abs = realpathSafe(path.resolve(filePath));
  const rel = path.relative(repoRoot, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join("/");
}

/** realpath that tolerates a not-yet-created file by resolving its directory. */
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
