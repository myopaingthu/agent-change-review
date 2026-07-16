import * as fs from "fs";
import * as path from "path";
import { parseDiff } from "./diffParser";
import {
  diffCommits,
  getGitDir,
  pathExistsInCommit,
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
 * Diffs each repo's baseline against its *current* working tree rather than the
 * recorded result commit, so the list stays live: rejected files drop out, and
 * later edits to the same files are reflected.
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
    try {
      const currentTree = await snapshotTree(part.repoRoot);
      diff = await diffCommits(part.repoRoot, part.baseCommit, currentTree, part.files);
    } catch {
      continue; // Repo may have gone away; show the rest.
    }
    for (const file of parseDiff(diff)) {
      out.push({ ...file, repoRoot: part.repoRoot });
    }
  }
  return out.sort(
    (a, b) => a.repoRoot.localeCompare(b.repoRoot) || a.path.localeCompare(b.path)
  );
}

/**
 * Reject one file within an interaction: revert it to the interaction's base
 * state for its repo, or delete it if the agent created it this request.
 */
export async function rejectInteractionFile(
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
