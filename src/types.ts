export type FileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked";

export interface Hunk {
  /** The raw hunk header line, e.g. "@@ -1,3 +1,4 @@ optional context". */
  header: string;
  /** All lines belonging to the hunk, including the header and the context/+/- body lines. */
  lines: string[];
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface ChangedFile {
  /** Current path, relative to the repo root, using forward slashes. */
  path: string;
  /** Original path for renames. */
  oldPath?: string;
  status: FileStatus;
  /** Full unified diff text for this file (the block starting at "diff --git"). */
  diff: string;
  hunks: Hunk[];
  binary: boolean;
  untracked: boolean;
}

/**
 * One line of a repo's timeline.jsonl: what a single agent request changed in
 * that one repo. A request touching several repos writes one record per repo,
 * all sharing the same `id` and `ts`.
 */
export interface InteractionRecord {
  /** Stable id (Claude's prompt_id, or a generated fallback). */
  id: string;
  /** What the user asked for in this request. */
  prompt: string;
  /** Checkpoint captured before the agent first edited this repo (PreToolUse). */
  baseCommit: string;
  /** Checkpoint captured after the agent finished (Stop). */
  resultCommit: string;
  /** Repo-relative paths the agent edited (from PostToolUse). */
  files: string[];
  ts: number;
}

/** One repo's share of an interaction. */
export interface InteractionPart {
  repoRoot: string;
  baseCommit: string;
  resultCommit: string;
  files: string[];
}

/** One agent request, merged across every repo it touched. */
export interface AggregatedInteraction {
  id: string;
  prompt: string;
  ts: number;
  parts: InteractionPart[];
}

/** A changed file, tagged with the repo it belongs to. */
export type RepoFile = ChangedFile & { repoRoot: string };

/** Message sent from the webview to the extension. Files are keyed by repo+path. */
export type InboundMessage =
  | { type: "refresh" }
  | { type: "newSession" }
  | { type: "acceptAll" }
  | { type: "rejectAll" }
  | { type: "acceptFile"; repoRoot: string; path: string }
  | { type: "rejectFile"; repoRoot: string; path: string }
  | { type: "acceptHunk"; repoRoot: string; path: string; hunkHash: string }
  | { type: "rejectHunk"; repoRoot: string; path: string; hunkHash: string }
  | { type: "openFile"; repoRoot: string; path: string }
  | { type: "initGit" }
  | { type: "installHook" };

/** Message sent from the extension to the webview. */
export type OutboundMessage =
  | {
      type: "render";
      files: RenderFile[];
      /** The request text, shown in the banner. */
      prompt: string;
      interactionTs: number;
      /** True when the request touched more than one repo. */
      multiRepo: boolean;
    }
  | { type: "error"; message: string }
  | { type: "empty"; reason: string; action?: "initGit" | "installHook" };

export interface RenderHunk {
  /** Stable content hash used to reference this hunk across refreshes. */
  hash: string;
  /** The hunk text (header + body lines). */
  text: string;
  reviewed: boolean;
}

export interface RenderFile {
  /** Repo this file belongs to; sent back with every action to route it. */
  repoRoot: string;
  /** Repo display name, shown as a group header when a request spans repos. */
  repo: string;
  path: string;
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  /** Whether per-hunk accept/reject is offered (false for binary files). */
  hunkActions: boolean;
  hunks: RenderHunk[];
  /** True when every hunk (or the whole binary file) has been accepted. */
  reviewed: boolean;
}
