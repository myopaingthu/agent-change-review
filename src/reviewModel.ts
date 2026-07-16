/**
 * Turns the agent's diff plus the user's review decisions into the webview's
 * render model. Kept free of `vscode` so it can be unit-tested headlessly.
 *
 * The rendered diff is frozen (the agent's base -> result), so unlike a live
 * diff it cannot show that something was rejected: rejecting reverse-applies to
 * the working tree, which the frozen diff never reads. Rejections are therefore
 * recorded and dropped from the render here.
 *
 * Recording is not redundant with getInteractionDiff's "file is back at its
 * baseline" check, which cannot see a rejection in a file the user also edited
 * by hand: the file still differs from the baseline afterwards, because their
 * edit remains. That state is byte-identical to the user having mangled the
 * agent's lines, so it can only be distinguished by remembering the decision.
 * The two mechanisms cover each other: the baseline check survives state loss
 * and catches undo done outside the panel, this catches the rest.
 */
import * as crypto from "crypto";
import { FileReview, Hunk, RenderFile, RenderHunk, RepoFile, ReviewMap } from "./types";

/** Files with no hunks (binary, mode-only) are resolved as a whole, under this key. */
const FILE_SENTINEL_PREFIX = "file:";

/** NUL separator: it cannot occur in a path, so keys can never collide. */
export function fileKey(repoRoot: string, filePath: string): string {
  return `${repoRoot}\0${filePath}`;
}

export function hashHunk(hunk: Hunk): string {
  return hashText(hunk.lines.join("\n"));
}

export function hashText(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

export function fileSentinel(file: RepoFile): string {
  return FILE_SENTINEL_PREFIX + hashText(file.diff);
}

function emptyReview(): FileReview {
  return { accepted: [], rejected: [] };
}

function reviewFor(review: ReviewMap, key: string): FileReview {
  const stored = review[key];
  if (!stored) {
    return emptyReview();
  }
  return {
    accepted: Array.isArray(stored.accepted) ? stored.accepted : [],
    rejected: Array.isArray(stored.rejected) ? stored.rejected : [],
  };
}

/**
 * Build the render model, and return a pruned copy of the review state holding
 * only decisions that still refer to hunks present in the diff.
 */
export function buildRenderModel(
  files: RepoFile[],
  review: ReviewMap
): { render: RenderFile[]; pruned: ReviewMap } {
  const pruned: ReviewMap = {};
  const render: RenderFile[] = [];

  for (const file of files) {
    const key = fileKey(file.repoRoot, file.path);
    const stored = reviewFor(review, key);
    const keep = emptyReview();

    const hunks: RenderHunk[] = [];
    for (const hunk of file.hunks) {
      const hash = hashHunk(hunk);
      if (stored.rejected.includes(hash)) {
        keep.rejected.push(hash);
        continue; // Already undone on disk; not pending review.
      }
      const accepted = stored.accepted.includes(hash);
      if (accepted) {
        keep.accepted.push(hash);
      }
      hunks.push({ hash, text: hunk.lines.join("\n"), reviewed: accepted });
    }

    const sentinel = fileSentinel(file);
    const wholeFileRejected = stored.rejected.includes(sentinel);
    if (wholeFileRejected) {
      keep.rejected.push(sentinel);
    }

    // Every hunk rejected (individually or by rejecting the file) means nothing
    // is left to review, whatever else the file may still differ by.
    const nothingLeft = wholeFileRejected || (file.hunks.length > 0 && hunks.length === 0);
    if (keep.accepted.length || keep.rejected.length) {
      pruned[key] = keep;
    }
    if (nothingLeft) {
      continue;
    }

    let reviewed: boolean;
    if (file.hunks.length === 0) {
      reviewed = stored.accepted.includes(sentinel);
      if (reviewed) {
        keep.accepted.push(sentinel);
        pruned[key] = keep;
      }
    } else {
      reviewed = hunks.every((h) => h.reviewed);
    }

    render.push({
      repoRoot: file.repoRoot,
      repo: basename(file.repoRoot),
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      binary: file.binary,
      hunkActions: !file.binary,
      hunks,
      reviewed,
      editedSinceAgent: file.editedSinceAgent,
    });
  }

  return { render, pruned };
}

/**
 * The hunks of a file still awaiting a decision — everything the user has not
 * already rejected. Rejecting a file must reverse-apply only these, since an
 * already-rejected hunk is gone from disk and would fail to apply again.
 */
export function pendingHunks(file: RepoFile, review: ReviewMap): Hunk[] {
  const stored = reviewFor(review, fileKey(file.repoRoot, file.path));
  if (!stored.rejected.length) {
    return file.hunks;
  }
  return file.hunks.filter((h) => !stored.rejected.includes(hashHunk(h)));
}

/** Mark every hunk of a file accepted (or the file itself, when it has no hunks). */
export function markFileAccepted(review: ReviewMap, file: RepoFile): void {
  const key = fileKey(file.repoRoot, file.path);
  const current = reviewFor(review, key);
  review[key] = {
    accepted:
      file.hunks.length === 0
        ? [fileSentinel(file)]
        : file.hunks.map((h) => hashHunk(h)),
    rejected: current.rejected,
  };
}

/**
 * Record that the agent's whole change to a file was undone. Marks the file
 * sentinel rather than each hunk, so it holds even for a hunk-less (binary)
 * file, and survives the diff being re-parsed.
 */
export function markFileRejected(review: ReviewMap, file: RepoFile): void {
  const key = fileKey(file.repoRoot, file.path);
  const current = reviewFor(review, key);
  const sentinel = fileSentinel(file);
  if (!current.rejected.includes(sentinel)) {
    current.rejected.push(sentinel);
  }
  current.accepted = [];
  review[key] = current;
}

export function markHunkAccepted(review: ReviewMap, key: string, hash: string): void {
  const current = reviewFor(review, key);
  if (!current.accepted.includes(hash)) {
    current.accepted.push(hash);
  }
  review[key] = current;
}

export function markHunkRejected(review: ReviewMap, key: string, hash: string): void {
  const current = reviewFor(review, key);
  if (!current.rejected.includes(hash)) {
    current.rejected.push(hash);
  }
  current.accepted = current.accepted.filter((h) => h !== hash);
  review[key] = current;
}

/** path.basename, inlined to keep this module dependency-free and pure. */
function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}
