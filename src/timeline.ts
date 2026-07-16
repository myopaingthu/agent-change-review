import * as fs from "fs";
import * as path from "path";
import { parseDiff } from "./diffParser";
import {
  changedPaths,
  diffCommits,
  getGitDir,
  pathExistsInCommit,
  rejectFilePatch,
  restorePathFromCommit,
  runGit,
  snapshotTree,
} from "./git";
import { AggregatedInteraction, InteractionPart, InteractionRecord, RepoFile } from "./types";

const CHECKPOINT_REF = "refs/acr/head";

async function getAcrDir(repoRoot: string): Promise<string> {
  return path.join(await getGitDir(repoRoot), "acr");
}

export async function getTimelinePath(repoRoot: string): Promise<string> {
  return path.join(await getAcrDir(repoRoot), "timeline.jsonl");
}

async function readRecords(repoRoot: string): Promise<InteractionRecord[]> {
  let timelinePath: string;
  try {
    timelinePath = await getTimelinePath(repoRoot);
  } catch {
    return [];
  }
  let raw: string;
  try {
    raw = await fs.promises.readFile(timelinePath, "utf8");
  } catch {
    return [];
  }
  const out: InteractionRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const rec = JSON.parse(trimmed) as InteractionRecord;
      if (rec.id && rec.baseCommit && rec.resultCommit && Array.isArray(rec.files)) {
        out.push(rec);
      }
    } catch {
      // Skip a malformed line rather than losing the whole timeline.
    }
  }
  return out;
}

/**
 * The most recent agent request across every repo. One request can touch several
 * repos, so records sharing the newest request's id are merged into one
 * interaction with a part per repo.
 */
export async function readLatestInteraction(
  repoRoots: string[]
): Promise<AggregatedInteraction | null> {
  const all: Array<InteractionRecord & { repoRoot: string }> = [];
  for (const repoRoot of repoRoots) {
    for (const rec of await readRecords(repoRoot)) {
      all.push({ ...rec, repoRoot });
    }
  }
  if (!all.length) {
    return null;
  }

  let newest = all[0];
  for (const rec of all) {
    if (rec.ts > newest.ts) {
      newest = rec;
    }
  }

  const parts: InteractionPart[] = all
    .filter((rec) => rec.id === newest.id)
    .map((rec) => ({
      repoRoot: rec.repoRoot,
      baseCommit: rec.baseCommit,
      resultCommit: rec.resultCommit,
      files: rec.files,
    }));

  return { id: newest.id, prompt: newest.prompt, ts: newest.ts, parts };
}

/**
 * Every file the interaction changed, across all repos it touched.
 *
 * The diff is always between the two recorded checkpoints (base -> result), so
 * it shows the agent's own edits and nothing else. The working tree is consulted
 * only to decide which files still need reviewing, never to build diff text —
 * otherwise the user's later edits to an agent-touched file leak into the review.
 */
export async function getInteractionDiff(
  interaction: AggregatedInteraction
): Promise<RepoFile[]> {
  const out: RepoFile[] = [];
  for (const part of interaction.parts) {
    if (!part.files.length) {
      continue;
    }
    let diff: string;
    let dirty: Set<string>;
    try {
      const currentTree = await snapshotTree(part.repoRoot);
      // Back at the baseline means the agent's change is gone (rejected, or
      // undone by hand), so there is nothing left to review for that file.
      const pending = await changedPaths(
        part.repoRoot,
        part.baseCommit,
        currentTree,
        part.files
      );
      if (!pending.size) {
        continue;
      }
      dirty = await changedPaths(
        part.repoRoot,
        part.resultCommit,
        currentTree,
        part.files
      );
      diff = await diffCommits(part.repoRoot, part.baseCommit, part.resultCommit, [
        ...pending,
      ]);
    } catch {
      continue; // Repo may have gone away; show the rest.
    }
    for (const file of parseDiff(diff)) {
      out.push({
        ...file,
        repoRoot: part.repoRoot,
        editedSinceAgent: dirty.has(file.path) || dirty.has(file.oldPath ?? file.path),
      });
    }
  }
  return out.sort(
    (a, b) => a.repoRoot.localeCompare(b.repoRoot) || a.path.localeCompare(b.path)
  );
}

/**
 * Undo the agent's change to one file, leaving any edits the user made to that
 * same file intact, by reverse-applying just the agent's diff.
 *
 * Throws PatchConflictError when the user's edits overlap the agent's own lines,
 * so the patch no longer applies. Callers should offer hardRestoreInteractionFile
 * as a confirmed fallback. Binary files have no applicable patch and always
 * take the restore path.
 */
export async function rejectInteractionFile(
  interaction: AggregatedInteraction,
  repoRoot: string,
  file: RepoFile
): Promise<void> {
  if (file.binary) {
    await hardRestoreInteractionFile(interaction, repoRoot, file.path);
    return;
  }
  await rejectFilePatch(repoRoot, file);
}

/**
 * Restore a file to its state before the agent's request, discarding anything
 * the user changed in it since. The blunt fallback for when the agent's diff
 * cannot be reverse-applied on its own.
 */
export async function hardRestoreInteractionFile(
  interaction: AggregatedInteraction,
  repoRoot: string,
  filePath: string
): Promise<void> {
  const part = interaction.parts.find((p) => p.repoRoot === repoRoot);
  if (!part) {
    throw new Error(`No recorded baseline for ${filePath}.`);
  }
  const existedBefore = await pathExistsInCommit(repoRoot, part.baseCommit, filePath);
  if (existedBefore) {
    await restorePathFromCommit(repoRoot, part.baseCommit, filePath);
  } else {
    await fs.promises.rm(path.join(repoRoot, filePath), { force: true });
  }
}

/**
 * Clear recorded timelines and reset the checkpoint chain, so the next agent
 * request starts from a fresh baseline.
 */
export async function clearTimeline(repoRoots: string[]): Promise<void> {
  for (const repoRoot of repoRoots) {
    let acrDir: string;
    try {
      acrDir = await getAcrDir(repoRoot);
    } catch {
      continue;
    }
    await fs.promises
      .rm(path.join(acrDir, "timeline.jsonl"), { force: true })
      .catch(() => undefined);
    try {
      await runGit(repoRoot, ["update-ref", "-d", CHECKPOINT_REF]);
    } catch {
      // Ref may not exist yet; ignore.
    }
  }
}
