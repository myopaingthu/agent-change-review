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
    hunks: splitHunks(parseHunks(blockLines)),
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

/** Lines of context kept around each run, matching git's own `--unified=3`. */
const CONTEXT_LINES = 3;

type LineKind = "context" | "change" | "noNewline";

function kindOf(line: string): LineKind {
  if (line.startsWith("+") || line.startsWith("-")) {
    return "change";
  }
  if (line.startsWith("\\")) {
    return "noNewline";
  }
  return "context";
}

/**
 * Re-cut hunks so each contiguous run of changed lines becomes its own hunk.
 *
 * `git diff -U3` emits one hunk whenever changes are within 6 lines of each
 * other, so unrelated edits arrive welded together and can only be accepted or
 * rejected as a group. Splitting per run makes each edit independently
 * reviewable, which is what the diff actually describes.
 */
export function splitHunks(hunks: Hunk[], context = CONTEXT_LINES): Hunk[] {
  const out: Hunk[] = [];
  for (const hunk of hunks) {
    out.push(...splitHunk(hunk, context));
  }
  return out;
}

function splitHunk(hunk: Hunk, context: number): Hunk[] {
  const body = hunk.lines.slice(1); // drop the @@ header
  const runs = findRuns(body);
  if (runs.length <= 1) {
    // Nothing to separate; keep git's own hunk, section heading and all.
    return [hunk];
  }

  // Old/new line number that each body line sits at.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const line of body) {
    oldAt.push(oldLine);
    newAt.push(newLine);
    const kind = kindOf(line);
    if (kind === "context") {
      oldLine++;
      newLine++;
    } else if (kind === "change") {
      if (line.startsWith("-")) {
        oldLine++;
      } else {
        newLine++;
      }
    }
  }

  // Partition the body rather than giving every run its own context window: two
  // runs less than 2*context apart would otherwise claim the same lines, and git
  // refuses a patch whose hunks overlap. Each gap is divided instead, so the
  // hunks still concatenate back into exactly this hunk.
  const bounds: Array<[number, number]> = [];
  for (let i = 0; i < runs.length; i++) {
    const from = i === 0 ? 0 : bounds[i - 1][1];
    const gap = i === runs.length - 1 ? 0 : runs[i + 1][0] - runs[i][1];
    const to =
      i === runs.length - 1 ? body.length : runs[i][1] + Math.min(context, gap);
    bounds.push([from, to]);
  }

  return bounds.map(([from, to]) => {
    const slice = body.slice(from, to);

    let oldLines = 0;
    let newLines = 0;
    for (const line of slice) {
      if (line.startsWith("-")) {
        oldLines++;
      } else if (line.startsWith("+")) {
        newLines++;
      } else if (kindOf(line) === "context") {
        oldLines++;
        newLines++;
      }
    }

    // git points a zero-length side at the line *before* the change.
    const oldStart = oldLines === 0 ? Math.max(0, oldAt[from] - 1) : oldAt[from];
    const newStart = newLines === 0 ? Math.max(0, newAt[from] - 1) : newAt[from];
    // No section heading: git's belongs to the parent hunk's start, and would be
    // wrong for the later runs rather than merely absent.
    const header = `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`;

    return {
      header,
      lines: [header, ...slice],
      oldStart,
      oldLines,
      newStart,
      newLines,
    };
  });
}

/** Maximal runs of changed lines, as [start, end) into the hunk body. */
function findRuns(body: string[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let i = 0;
  while (i < body.length) {
    if (kindOf(body[i]) !== "change") {
      i++;
      continue;
    }
    const start = i;
    // A "\ No newline" marker describes the line before it, so it travels with
    // the run rather than ending it.
    while (i < body.length && kindOf(body[i]) !== "context") {
      i++;
    }
    runs.push([start, i]);
  }
  return runs;
}

const HUNK_SECTION = /^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)(?: (.*))?$/;

/** The "public function foo()" trailing part of a hunk header, if git set one. */
function sectionOf(header: string): string {
  const m = header.match(HUNK_SECTION);
  return m && m[2] ? m[2].trim() : "";
}

/**
 * Label re-cut hunks with the enclosing declaration git itself would name.
 *
 * Splitting a hunk invalidates git's own label, which describes the *parent*
 * hunk's start. Recomputing it here is not an option: which lines count as a
 * declaration depends on the userdiff driver `.gitattributes` selects (Laravel
 * sets `*.php diff=php`, so indented declarations match where git's default
 * would not), and those patterns are compiled into git per language.
 *
 * So let git label them. `labelled` comes from the same diff at `--unified=0`,
 * which emits exactly one hunk per run of changed lines — the same cuts made
 * here — each carrying git's own label for that run's position.
 */
export function applySectionHeadings(
  files: ChangedFile[],
  labelled: ChangedFile[]
): void {
  const byPath = new Map(labelled.map((f) => [f.path, f]));
  for (const file of files) {
    const source = byPath.get(file.path);
    // Both sides are one-hunk-per-run, so they line up. If they ever don't,
    // leave the headers bare rather than mislabelling them.
    if (!source || source.hunks.length !== file.hunks.length) {
      continue;
    }
    file.hunks.forEach((hunk, i) => {
      const section = sectionOf(source.hunks[i].header);
      if (!section || sectionOf(hunk.header)) {
        return; // Nothing to add, or git's own label is still accurate.
      }
      const header = `${hunk.header} ${section}`;
      hunk.header = header;
      hunk.lines[0] = header;
    });
  }
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
 * Build a standalone unified-diff patch carrying just the given hunks of a file,
 * suitable for `git apply --reverse`. Passing a subset is how already-rejected
 * hunks are left out, so the rest still applies.
 */
export function buildFilePatch(file: ChangedFile, hunks: Hunk[]): string {
  const header = fileHeaderText(file.diff);
  const body = hunks.map((h) => h.lines.join("\n")).join("\n");
  return `${header}\n${body}\n`;
}

/** Build a standalone patch containing a single hunk. */
export function buildHunkPatch(file: ChangedFile, hunk: Hunk): string {
  return buildFilePatch(file, [hunk]);
}

function stripPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) {
    return p.slice(2);
  }
  return p;
}
