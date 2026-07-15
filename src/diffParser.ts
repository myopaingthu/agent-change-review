import { ChangedFile, FileStatus, Hunk } from "./types";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse the output of `git diff` (one or more file blocks) into structured
 * changed files. Only tracked-file changes appear in git diff output; untracked
 * files are handled separately in git.ts.
 */
export function parseDiff(diffText: string): ChangedFile[] {
  if (!diffText.trim()) {
    return [];
  }

  const lines = diffText.split("\n");
  const files: ChangedFile[] = [];
  let current: string[] | null = null;

  const flush = () => {
    if (current && current.length) {
      const file = parseFileBlock(current);
      if (file) {
        files.push(file);
      }
    }
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  flush();

  return files;
}

function parseFileBlock(blockLines: string[]): ChangedFile | null {
  const diff = blockLines.join("\n");
  const header = blockLines[0];

  let path = "";
  let oldPath: string | undefined;
  let status: FileStatus = "modified";
  let binary = false;

  // Fall back to the "diff --git a/<x> b/<y>" line for the paths.
  const gitMatch = header.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (gitMatch) {
    oldPath = gitMatch[1];
    path = gitMatch[2];
  }

  for (const line of blockLines) {
    if (line.startsWith("new file mode")) {
      status = "added";
    } else if (line.startsWith("deleted file mode")) {
      status = "deleted";
    } else if (line.startsWith("rename from ")) {
      status = "renamed";
      oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      status = "renamed";
      path = line.slice("rename to ".length);
    } else if (line.startsWith("--- ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") {
        oldPath = stripPrefix(p);
      }
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") {
        path = stripPrefix(p);
      }
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      binary = true;
    }
  }

  if (!path && oldPath) {
    path = oldPath;
  }
  if (!path) {
    return null;
  }

  return {
    path,
    oldPath: oldPath && oldPath !== path ? oldPath : undefined,
    status,
    diff,
    hunks: parseHunks(blockLines),
    binary,
    untracked: false,
  };
}

/** Extract the hunks from a file block's lines. */
export function parseHunks(blockLines: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const line of blockLines) {
    const m = line.match(HUNK_HEADER);
    if (m) {
      if (current) {
        hunks.push(current);
      }
      current = {
        header: line,
        lines: [line],
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
      };
    } else if (current) {
      // Body lines start with ' ', '+', '-', or '\' (no newline marker).
      if (
        line.startsWith(" ") ||
        line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith("\\")
      ) {
        current.lines.push(line);
      }
    }
  }
  if (current) {
    hunks.push(current);
  }
  return hunks;
}

/** The file-block header lines (everything before the first hunk header). */
export function fileHeaderText(diff: string): string {
  const out: string[] = [];
  for (const line of diff.split("\n")) {
    if (HUNK_HEADER.test(line)) {
      break;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Build a standalone unified-diff patch containing a single hunk, suitable for
 * `git apply --reverse`.
 */
export function buildHunkPatch(file: ChangedFile, hunk: Hunk): string {
  const header = fileHeaderText(file.diff);
  const body = hunk.lines.join("\n");
  return `${header}\n${body}\n`;
}

function stripPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) {
    return p.slice(2);
  }
  return p;
}
