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
 * One agent request recorded by the Claude Code hook. The diff shown in the
 * review is `baseCommit -> resultCommit`, scoped to `files`.
 */
export interface Interaction {
  /** Stable id (Claude's prompt_id, or a generated fallback). */
  id: string;
  /** What the user asked for in this request. */
  prompt: string;
  /** Working-tree checkpoint captured before the agent edited (UserPromptSubmit). */
  baseCommit: string;
  /** Working-tree checkpoint captured after the agent finished (Stop). */
  resultCommit: string;
  /** Repo-relative paths the agent edited this request (from PostToolUse). */
  files: string[];
  ts: number;
}

/** Message sent from the webview to the extension. */
export type InboundMessage =
  | { type: "refresh" }
  | { type: "newSession" }
  | { type: "acceptAll" }
  | { type: "rejectAll" }
  | { type: "acceptFile"; path: string }
  | { type: "rejectFile"; path: string }
  | { type: "acceptHunk"; path: string; hunkHash: string }
  | { type: "rejectHunk"; path: string; hunkHash: string }
  | { type: "openFile"; path: string }
  | { type: "initGit" };

/** Message sent from the extension to the webview. */
export type OutboundMessage =
  | {
      type: "render";
      repoRoot: string;
      files: RenderFile[];
      /** "timeline" when showing a single agent request; "worktree" otherwise. */
      mode: "worktree" | "timeline";
      /** The request text, shown as a banner in timeline mode. */
      prompt?: string;
      interactionTs?: number;
    }
  | { type: "error"; message: string }
  | { type: "empty"; reason: string; action?: "initGit" };

export interface RenderHunk {
  /** Stable content hash used to reference this hunk across refreshes. */
  hash: string;
  /** The hunk text (header + body lines). */
  text: string;
  reviewed: boolean;
}

export interface RenderFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  untracked: boolean;
  /** Whether per-hunk accept/reject is offered (false for binary/untracked). */
  hunkActions: boolean;
  hunks: RenderHunk[];
  /** True when every hunk (or the whole binary file) has been accepted. */
  reviewed: boolean;
  /** True when the file was modified at/after the current session baseline. */
  session: boolean;
}
