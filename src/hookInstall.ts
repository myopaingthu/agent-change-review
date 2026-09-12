import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  applyOurGroups,
  hasOurGroups,
  HookSettings,
  matchesOurGroups,
  removeOurGroups,
} from "./hookSettings";

type HookScope = "project" | "global";

/** Where installs before 0.4 copied the spawned hook runner. */
function legacyRunnerPath(): string {
  return path.join(os.homedir(), ".claude", "acr", "hook.js");
}

export async function installHook(baseUrl: string | undefined): Promise<void> {
  if (!baseUrl) {
    vscode.window.showErrorMessage(
      "Agent Change Review: the hook receiver could not start, so there is no address to register. Reload the window and try again."
    );
    return;
  }

  const scope = getScope();
  const settingsPath = resolveSettingsPath(scope);
  if (!settingsPath) {
    vscode.window.showErrorMessage(
      "Agent Change Review: open a folder before installing the Claude Code hook."
    );
    return;
  }

  let settings: HookSettings;
  try {
    settings = readSettings(settingsPath);
  } catch {
    vscode.window.showErrorMessage(
      `Agent Change Review: could not parse ${settingsPath}. Fix or remove it, then retry.`
    );
    return;
  }

  settings.hooks = settings.hooks ?? {};
  applyOurGroups(settings.hooks, baseUrl);

  try {
    writeSettings(settingsPath, settings);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Agent Change Review: could not write ${settingsPath}: ${String(err)}`
    );
    return;
  }

  removeLegacyRunner();

  const choice = await vscode.window.showInformationMessage(
    `Claude Code hook installed (${scope}). Restart your Claude Code session so it picks up the hook, then your next request will appear in the review panel.`,
    "Show settings"
  );
  if (choice === "Show settings") {
    void vscode.window.showTextDocument(vscode.Uri.file(settingsPath));
  }
}

/**
 * Keep an existing install pointing at this window's receiver.
 *
 * Runs on activation and rewrites our entries in place when they are stale —
 * either the legacy `node` command form from before 0.4, or a URL whose port
 * moved because the fixed one was taken. Files without our entries are left
 * alone, so this never installs the hook behind the user's back.
 */
export function syncHookConfig(baseUrl: string | undefined): void {
  if (!baseUrl) {
    return;
  }
  let migrated = false;

  for (const settingsPath of candidateSettingsPaths()) {
    let settings: HookSettings;
    try {
      settings = readSettings(settingsPath);
    } catch {
      continue; // Malformed file; installHook reports it properly.
    }
    if (!hasOurGroups(settings.hooks) || matchesOurGroups(settings.hooks, baseUrl)) {
      continue;
    }
    settings.hooks = settings.hooks ?? {};
    applyOurGroups(settings.hooks, baseUrl);
    try {
      writeSettings(settingsPath, settings);
      migrated = true;
    } catch {
      // Read-only or unwritable; leave it to an explicit reinstall.
    }
  }

  if (migrated) {
    removeLegacyRunner();
    vscode.window.showInformationMessage(
      "Agent Change Review: updated the Claude Code hook — it no longer needs Node.js installed. Restart your Claude Code session to pick it up."
    );
  }
}

export async function uninstallHook(): Promise<void> {
  let removed = false;

  for (const settingsPath of candidateSettingsPaths()) {
    let settings: HookSettings;
    try {
      settings = readSettings(settingsPath);
    } catch {
      vscode.window.showErrorMessage(
        `Agent Change Review: could not parse ${settingsPath}.`
      );
      continue;
    }
    if (!hasOurGroups(settings.hooks)) {
      continue;
    }
    removeOurGroups(settings.hooks!);
    if (Object.keys(settings.hooks!).length === 0) {
      delete settings.hooks;
    }
    try {
      writeSettings(settingsPath, settings);
      removed = true;
    } catch (err) {
      vscode.window.showErrorMessage(
        `Agent Change Review: could not write ${settingsPath}: ${String(err)}`
      );
    }
  }

  removeLegacyRunner();
  vscode.window.showInformationMessage(
    removed
      ? "Agent Change Review: Claude Code hook removed."
      : "Agent Change Review: no hook to remove."
  );
}

/** Both files an install could live in, so a scope change can't strand entries. */
function candidateSettingsPaths(): string[] {
  const paths: string[] = [];
  const project = resolveSettingsPath("project");
  if (project) {
    paths.push(project);
  }
  paths.push(resolveSettingsPath("global")!);
  return paths.filter((p) => fs.existsSync(p));
}

function removeLegacyRunner(): void {
  try {
    fs.rmSync(legacyRunnerPath(), { force: true });
  } catch {
    // Best effort; an orphaned copy is harmless once nothing references it.
  }
}

function getScope(): HookScope {
  return vscode.workspace
    .getConfiguration("agentChangeReview")
    .get<HookScope>("hookScope", "project");
}

function resolveSettingsPath(scope: HookScope): string | undefined {
  if (scope === "global") {
    return path.join(os.homedir(), ".claude", "settings.json");
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  return path.join(folder.uri.fsPath, ".claude", "settings.local.json");
}

function readSettings(settingsPath: string): HookSettings {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }
  const raw = fs.readFileSync(settingsPath, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as HookSettings;
}

function writeSettings(settingsPath: string, settings: HookSettings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
