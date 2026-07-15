import * as vscode from "vscode";
import { installHook, syncHookRunner, uninstallHook } from "./hookInstall";
import { countReviewableChanges, ReviewPanel } from "./reviewPanel";

export function activate(context: vscode.ExtensionContext): void {
  const ensurePanel = () => ReviewPanel.current ?? ReviewPanel.createOrShow(context);

  // Keep the globally-installed hook runner in sync with this build.
  syncHookRunner(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("agentChangeReview.open", () => {
      ReviewPanel.createOrShow(context);
    }),
    vscode.commands.registerCommand("agentChangeReview.refresh", () => {
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
    vscode.commands.registerCommand("agentChangeReview.installHook", () => {
      void installHook(context);
    }),
    vscode.commands.registerCommand("agentChangeReview.uninstallHook", () => {
      void uninstallHook();
    })
  );

  // Lets external tools (e.g. a Claude Code hook) open/refresh the panel via
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

  registerAutoRefresh(context);
}

function registerAutoRefresh(context: vscode.ExtensionContext): void {
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const isNoise = (uri: vscode.Uri) =>
    /(^|[/\\])(\.git|node_modules|out|dist|\.vscode-test)([/\\]|$)/.test(uri.fsPath);

  const debounced = debounce((uri: vscode.Uri) => {
    if (isNoise(uri)) {
      return;
    }
    const config = vscode.workspace.getConfiguration("agentChangeReview");

    if (ReviewPanel.current) {
      if (config.get<boolean>("autoRefresh", true)) {
        void ReviewPanel.current.refresh();
      }
      return;
    }

    if (config.get<boolean>("autoOpen", false)) {
      void countReviewableChanges().then((n) => {
        if (n > 0 && !ReviewPanel.current) {
          ReviewPanel.createOrShow(context);
        }
      });
    }
  }, 500);

  watcher.onDidChange(debounced, null, context.subscriptions);
  watcher.onDidCreate(debounced, null, context.subscriptions);
  watcher.onDidDelete(debounced, null, context.subscriptions);
  context.subscriptions.push(watcher);
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
  // Nothing to clean up; disposables are tracked via context.subscriptions.
}
