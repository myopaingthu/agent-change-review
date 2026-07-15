import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { applyOurGroups, HookSettings, removeOurGroups } from "./hookSettings";

type HookScope = "project" | "global";

/** Absolute path to the synced hook runner used by Claude Code's hook commands. */
export function getGlobalHookPath(): string {
  return path.join(os.homedir(), ".claude", "acr", "hook.js");
}

/**
 * Copy the extension's compiled hook runner to a stable global path so the hook
 * command in settings survives extension updates (which change the install dir).
 */
export function syncHookRunner(context: vscode.ExtensionContext): void {
  const source = path.join(context.extensionPath, "out", "hookRunner.js");
  const dest = getGlobalHookPath();
  try {
    if (!fs.existsSync(source)) {
      return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
  } catch {
    // Best effort; installHook surfaces a clear error if the runner is missing.
  }
}

export async function installHook(context: vscode.ExtensionContext): Promise<void> {
  const source = path.join(context.extensionPath, "out", "hookRunner.js");
  if (!fs.existsSync(source)) {
    vscode.window.showErrorMessage(
      "Agent Change Review: hook runner not found. Compile the extension first (npm run compile)."
    );
    return;
  }
  syncHookRunner(context);

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

  const hookPath = getGlobalHookPath();
  settings.hooks = settings.hooks ?? {};
  applyOurGroups(settings.hooks, hookPath);

  try {
    writeSettings(settingsPath, settings);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Agent Change Review: could not write ${settingsPath}: ${String(err)}`
    );
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Claude Code hook installed (${scope}). Restart your Claude Code session so it picks up the hook, then your next request will appear in the review panel.`,
    "Show settings"
  );
  if (choice === "Show settings") {
    void vscode.window.showTextDocument(vscode.Uri.file(settingsPath));
  }
}

export async function uninstallHook(): Promise<void> {
  const scope = getScope();
  const settingsPath = resolveSettingsPath(scope);
  if (!settingsPath || !fs.existsSync(settingsPath)) {
    vscode.window.showInformationMessage("Agent Change Review: no hook to remove.");
    return;
  }

  let settings: HookSettings;
  try {
    settings = readSettings(settingsPath);
  } catch {
    vscode.window.showErrorMessage(
      `Agent Change Review: could not parse ${settingsPath}.`
    );
    return;
  }

  const hookPath = getGlobalHookPath();
  if (settings.hooks) {
    removeOurGroups(settings.hooks, hookPath);
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
  }

  try {
    writeSettings(settingsPath, settings);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Agent Change Review: could not write ${settingsPath}: ${String(err)}`
    );
    return;
  }
  vscode.window.showInformationMessage("Agent Change Review: Claude Code hook removed.");
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
