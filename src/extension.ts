import * as crypto from "crypto";
import * as fs from "fs";
import * as vscode from "vscode";
import { installHook, syncHookConfig, uninstallHook } from "./hookInstall";
import { HookServer } from "./hookServer";
import { discoverRepos, invalidateRepoCache } from "./repoResolver";
import { hasPendingReview, ReviewPanel } from "./reviewPanel";
import { getTimelinePath } from "./timeline";

const HOOK_TOKEN_KEY = "agentChangeReview.hookToken";

export function activate(context: vscode.ExtensionContext): void {
  const ensurePanel = () => ReviewPanel.current ?? ReviewPanel.createOrShow(context);

  // Bring up the receiver Claude Code posts to, then repair any existing install
  // whose address has gone stale.
  const hookServer = new HookServer();
  context.subscriptions.push(hookServer);
  const serverReady = hookServer
    .start(getHookToken(context))
    .then(() => syncHookConfig(hookServer.baseUrl))
    .catch(() => undefined);

  context.subscriptions.push(
    vscode.commands.registerCommand("agentChangeReview.open", () => {
      ReviewPanel.createOrShow(context);
    }),
    vscode.commands.registerCommand("agentChangeReview.refresh", () => {
      invalidateRepoCache();
      void ensurePanel().refresh();
    }),
    vscode.commands.registerCommand("agentChangeReview.acceptAll", () => {
      void ensurePanel().acceptAll();
    }),
    vscode.commands.registerCommand("agentChangeReview.rejectAll", () => {
      void ensurePanel().rejectAll();
    }),
    vscode.commands.registerCommand("agentChangeReview.newSession", () => {
      void ensurePanel().newSession();
    }),
    vscode.commands.registerCommand("agentChangeReview.installHook", async () => {
      await serverReady;
      await installHook(hookServer.baseUrl);
    }),
    vscode.commands.registerCommand("agentChangeReview.uninstallHook", () => {
      void uninstallHook();
    })
  );

  // Lets external tools open/refresh the panel via
  //   code --open-url "vscode://<publisher>.agent-change-review/open"
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        if (uri.path === "/refresh" && ReviewPanel.current) {
          void ReviewPanel.current.refresh();
        } else {
          ReviewPanel.createOrShow(context);
        }
      },
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      invalidateRepoCache();
      void syncAutoOpenWatchers(context);
      void ReviewPanel.current?.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentChangeReview.autoOpen")) {
        void syncAutoOpenWatchers(context);
      }
    })
  );

  registerAutoRefresh(context);
  void syncAutoOpenWatchers(context);
}

/**
 * Refresh an open panel as files change: the review diffs each checkpoint
 * against the current working tree, so edits and rejects are reflected live.
 */
function registerAutoRefresh(context: vscode.ExtensionContext): void {
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const isNoise = (uri: vscode.Uri) =>
    /(^|[/\\])(\.git|node_modules|out|dist|\.vscode-test)([/\\]|$)/.test(uri.fsPath);

  const debounced = debounce((uri: vscode.Uri) => {
    if (isNoise(uri) || !ReviewPanel.current) {
      return;
    }
    if (vscode.workspace.getConfiguration("agentChangeReview").get("autoRefresh", true)) {
      void ReviewPanel.current.refresh();
    }
  }, 500);

  watcher.onDidChange(debounced, null, context.subscriptions);
  watcher.onDidCreate(debounced, null, context.subscriptions);
  watcher.onDidDelete(debounced, null, context.subscriptions);
  context.subscriptions.push(watcher);
}

/**
 * Open the panel when the agent records a new request. Watches each repo's
 * timeline directly with fs.watchFile, because the timeline lives inside `.git`,
 * which VS Code's file watcher excludes.
 */
const autoOpenWatchers = new Map<string, () => void>();

async function syncAutoOpenWatchers(context: vscode.ExtensionContext): Promise<void> {
  const enabled = vscode.workspace
    .getConfiguration("agentChangeReview")
    .get<boolean>("autoOpen", false);

  const wanted = new Set<string>();
  if (enabled) {
    try {
      for (const repo of await discoverRepos()) {
        try {
          wanted.add(await getTimelinePath(repo));
        } catch {
          // Repo went away; skip it.
        }
      }
    } catch {
      // Discovery failed; leave watchers as they are.
    }
  }

  for (const [timelinePath, listener] of autoOpenWatchers) {
    if (!wanted.has(timelinePath)) {
      fs.unwatchFile(timelinePath, listener);
      autoOpenWatchers.delete(timelinePath);
    }
  }

  for (const timelinePath of wanted) {
    if (autoOpenWatchers.has(timelinePath)) {
      continue;
    }
    const listener = () => {
      if (ReviewPanel.current) {
        return;
      }
      void hasPendingReview().then((pending) => {
        if (pending && !ReviewPanel.current) {
          ReviewPanel.createOrShow(context);
        }
      });
    };
    fs.watchFile(timelinePath, { interval: 1000 }, listener);
    autoOpenWatchers.set(timelinePath, listener);
  }
}

/**
 * The secret in the receiver's URL, so only Claude Code — which reads it from
 * the settings file we wrote — can post events. Stored in globalState, which is
 * shared across windows, so every window agrees on one address.
 */
function getHookToken(context: vscode.ExtensionContext): string {
  const existing = context.globalState.get<string>(HOOK_TOKEN_KEY);
  if (existing) {
    return existing;
  }
  const token = crypto.randomBytes(16).toString("hex");
  void context.globalState.update(HOOK_TOKEN_KEY, token);
  return token;
}

function debounce<T extends (arg: vscode.Uri) => void>(fn: T, ms: number): T {
  let timer: NodeJS.Timeout | undefined;
  return ((arg: vscode.Uri) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => fn(arg), ms);
  }) as T;
}

export function deactivate(): void {
  for (const [timelinePath, listener] of autoOpenWatchers) {
    fs.unwatchFile(timelinePath, listener);
  }
  autoOpenWatchers.clear();
}
