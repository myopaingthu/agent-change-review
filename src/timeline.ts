import * as fs from "fs";
import * as path from "path";
import { parseDiff } from "./diffParser";
import {
  diffCommits,
  getGitDir,
  pathExistsInCommit,
  restorePathFromCommit,
  runGit,
} from "./git";
import { ChangedFile, Interaction } from "./types";

const CHECKPOINT_REF = "refs/acr/head";

async function getAcrDir(repoRoot: string): Promise<string> {
  return path.join(await getGitDir(repoRoot), "acr");
}

export async function getTimelinePath(repoRoot: string): Promise<string> {
  return path.join(await getAcrDir(repoRoot), "timeline.jsonl");
}

/** Whether the hook has recorded at least one interaction for this repo. */
export async function hasTimeline(repoRoot: string): Promise<boolean> {
  return (await readInteractions(repoRoot)).length > 0;
}

/** The most recent interaction, or null if the timeline is empty/absent. */
export async function readLatestInteraction(
  repoRoot: string
): Promise<Interaction | null> {
  const all = await readInteractions(repoRoot);
  return all.length ? all[all.length - 1] : null;
}

async function readInteractions(repoRoot: string): Promise<Interaction[]> {
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
  const out: Interaction[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const rec = JSON.parse(trimmed) as Interaction;
      if (rec.baseCommit && rec.resultCommit && Array.isArray(rec.files)) {
        out.push(rec);
      }
    } catch {
      // Skip a malformed line rather than losing the whole timeline.
    }
  }
  return out;
}

/** The files an interaction changed, as parsed ChangedFile diffs (base -> result). */
export async function getInteractionDiff(
  repoRoot: string,
  interaction: Interaction
): Promise<ChangedFile[]> {
  if (interaction.files.length === 0) {
    return [];
  }
  const diff = await diffCommits(
    repoRoot,
    interaction.baseCommit,
    interaction.resultCommit,
    interaction.files
  );
  return parseDiff(diff).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Reject one file within an interaction: revert it to the interaction's base
 * state, or delete it if the agent created it this request.
 */
export async function rejectInteractionFile(
  repoRoot: string,
  interaction: Interaction,
  filePath: string
): Promise<void> {
  const existedBefore = await pathExistsInCommit(
    repoRoot,
    interaction.baseCommit,
    filePath
  );
  if (existedBefore) {
    await restorePathFromCommit(repoRoot, interaction.baseCommit, filePath);
  } else {
    await fs.promises.rm(path.join(repoRoot, filePath), { force: true });
  }
}

/**
 * Clear the recorded timeline and reset the checkpoint chain. Used by
 * "New Session" so the next agent request starts a fresh baseline.
 */
export async function clearTimeline(repoRoot: string): Promise<void> {
  const acrDir = await getAcrDir(repoRoot);
  await Promise.all([
    fs.promises.rm(path.join(acrDir, "timeline.jsonl"), { force: true }),
    fs.promises.rm(path.join(acrDir, "pending.json"), { force: true }),
    fs.promises.rm(path.join(acrDir, "pending-files"), { force: true }),
  ]);
  try {
    await runGit(repoRoot, ["update-ref", "-d", CHECKPOINT_REF]);
  } catch {
    // Ref may not exist yet; ignore.
  }
}
