import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  getChangedFiles,
  getRepoRoot,
  GitError,
  gitInit,
  rejectFile,
  rejectHunk,
} from "./git";
import { compileIgnore } from "./ignore";
import {
  clearTimeline,
  getInteractionDiff,
  getTimelinePath,
  hasTimeline,
  readLatestInteraction,
  rejectInteractionFile,
} from "./timeline";
import {
  ChangedFile,
  Hunk,
  InboundMessage,
  Interaction,
  RenderFile,
  RenderHunk,
} from "./types";

const REVIEWED_STATE_KEY = "agentChangeReview.reviewed";
const SESSION_STATE_KEY = "agentChangeReview.sessionStart";
const TIMELINE_REVIEWED_KEY = "agentChangeReview.timelineReviewed";

type Mode = "worktree" | "timeline";
type RenderFileBase = Omit<RenderFile, "session">;

function getIgnorePredicate(): (relativePath: string) => boolean {
  const patterns = vscode.workspace
    .getConfiguration("agentChangeReview")
    .get<string[]>("ignore", []);
  return compileIgnore(patterns);
}

/**
 * Count changes that would appear in the review (repo changes minus ignored
 * files). Used to decide whether to auto-open the panel.
 */
export async function countReviewableChanges(): Promise<number> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return 0;
  }
  const repoRoot = await getRepoRoot(folder.uri.fsPath);
  if (!repoRoot) {
    return 0;
  }
  const ignore = getIgnorePredicate();
  const files = await getChangedFiles(repoRoot);
  return files.filter((f) => !ignore(f.path)).length;
}

/** Path -> list of accepted hunk hashes (or a file sentinel for binary files). */
type ReviewedMap = Record<string, string[]>;

export class ReviewPanel {
  public static current: ReviewPanel | undefined;
  private static readonly viewType = "agentChangeReview";

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];
  private files: ChangedFile[] = [];
  private repoRoot: string | undefined;
  private mode: Mode = "worktree";
  private interaction: Interaction | null = null;
  private watchedTimelinePath: string | undefined;
  private timelineListener: (() => void) | undefined;

  public static createOrShow(context: vscode.ExtensionContext): ReviewPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (ReviewPanel.current) {
      ReviewPanel.current.panel.reveal(column);
      void ReviewPanel.current.refresh();
      return ReviewPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      ReviewPanel.viewType,
      "Agent Change Review",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    ReviewPanel.current = new ReviewPanel(panel, context);
    return ReviewPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;

    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: InboundMessage) => this.handleMessage(message),
      null,
      this.disposables
    );

    void this.refresh();
  }

  public async refresh(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.post({ type: "empty", reason: "Open a folder to review agent changes." });
      return;
    }

    let repoRoot: string | null;
    try {
      repoRoot = await getRepoRoot(folder.uri.fsPath);
    } catch (err) {
      this.post({ type: "error", message: this.describeError(err) });
      return;
    }

    if (!repoRoot) {
      this.post({
        type: "empty",
        reason:
          "This folder isn't a Git repository. Agent Change Review uses Git to snapshot and revert agent changes.",
        action: "initGit",
      });
      return;
    }
    this.repoRoot = repoRoot;
    await this.ensureTimelineWatcher(repoRoot);

    let timelinePresent = false;
    try {
      timelinePresent = await hasTimeline(repoRoot);
    } catch {
      timelinePresent = false;
    }

    if (timelinePresent) {
      await this.refreshTimeline(repoRoot);
    } else {
      await this.refreshWorktree(repoRoot);
    }
  }

  /** Timeline mode: show only what the agent changed in its latest request. */
  private async refreshTimeline(repoRoot: string): Promise<void> {
    this.mode = "timeline";
    this.interaction = await readLatestInteraction(repoRoot);
    if (!this.interaction) {
      await this.refreshWorktree(repoRoot);
      return;
    }

    try {
      this.files = await getInteractionDiff(repoRoot, this.interaction);
    } catch (err) {
      this.post({ type: "error", message: this.describeError(err) });
      return;
    }

    if (this.files.length === 0) {
      const asked = this.interaction.prompt
        ? ` ("${clip(this.interaction.prompt)}")`
        : "";
      this.post({
        type: "empty",
        reason: `No changes left from your last request${asked}. Waiting for the next one…`,
      });
      return;
    }

    const renderFiles = await this.buildTimelineRenderFiles(this.interaction);
    this.post({
      type: "render",
      repoRoot,
      files: renderFiles,
      mode: "timeline",
      prompt: this.interaction.prompt,
      interactionTs: this.interaction.ts,
    });
  }

  /** Working-tree mode: show all changes vs HEAD (the original behaviour). */
  private async refreshWorktree(repoRoot: string): Promise<void> {
    this.mode = "worktree";
    this.interaction = null;
    try {
      const ignore = getIgnorePredicate();
      this.files = (await getChangedFiles(repoRoot)).filter((f) => !ignore(f.path));
    } catch (err) {
      this.post({ type: "error", message: this.describeError(err) });
      return;
    }

    if (this.files.length === 0) {
      this.post({ type: "empty", reason: "No changes found. You're all caught up." });
      return;
    }

    const renderFiles = await this.buildRenderFiles();
    this.post({ type: "render", repoRoot, files: renderFiles, mode: "worktree" });
  }

  /** Build the worktree render model and prune stale reviewed entries. */
  private async buildRenderFiles(): Promise<RenderFile[]> {
    const { render, pruned } = this.computeReviewed(this.files, this.getReviewedMap());
    const sessionStart = this.context.workspaceState.get<number>(SESSION_STATE_KEY, 0);

    const out: RenderFile[] = [];
    for (const base of render) {
      const session = (await this.fileMtime(base.path)) >= sessionStart;
      out.push({ ...base, session });
    }

    await this.context.workspaceState.update(REVIEWED_STATE_KEY, pruned);
    return out;
  }

  /** Build the timeline render model, tracking reviewed state per interaction. */
  private async buildTimelineRenderFiles(
    interaction: Interaction
  ): Promise<RenderFile[]> {
    const { render, pruned } = this.computeReviewed(
      this.files,
      this.getTimelineReviewed(interaction.id)
    );
    await this.setTimelineReviewed(interaction.id, pruned);
    return render.map((base) => ({ ...base, session: false }));
  }

  /**
   * Compute per-file/per-hunk reviewed flags and the pruned reviewed map (drops
   * entries whose hunks no longer exist in the current diff).
   */
  private computeReviewed(
    files: ChangedFile[],
    reviewed: ReviewedMap
  ): { render: RenderFileBase[]; pruned: ReviewedMap } {
    const pruned: ReviewedMap = {};
    const render: RenderFileBase[] = [];

    for (const file of files) {
      const stored = reviewed[file.path] ?? [];
      const hunkActions = !file.binary && !file.untracked;

      const renderHunks: RenderHunk[] = file.hunks.map((h) => {
        const hash = hashHunk(h);
        return { hash, text: h.lines.join("\n"), reviewed: stored.includes(hash) };
      });

      const fileSentinel = "file:" + hashText(file.diff);
      let fileReviewed: boolean;
      const keep: string[] = [];

      if (renderHunks.length === 0) {
        fileReviewed = stored.includes(fileSentinel);
        if (fileReviewed) {
          keep.push(fileSentinel);
        }
      } else {
        fileReviewed = renderHunks.every((h) => h.reviewed);
        for (const h of renderHunks) {
          if (h.reviewed) {
            keep.push(h.hash);
          }
        }
      }

      if (keep.length) {
        pruned[file.path] = keep;
      }

      render.push({
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
        binary: file.binary,
        untracked: file.untracked,
        hunkActions,
        hunks: renderHunks,
        reviewed: fileReviewed,
      });
    }

    return { render, pruned };
  }

  private async fileMtime(relativePath: string): Promise<number> {
    if (!this.repoRoot) {
      return 0;
    }
    try {
      const stat = await fs.promises.stat(path.join(this.repoRoot, relativePath));
      return stat.mtimeMs;
    } catch {
      // Deleted files have no mtime; treat as before the session baseline.
      return 0;
    }
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    switch (message.type) {
      case "refresh":
        await this.refresh();
        break;
      case "newSession":
        await this.newSession();
        break;
      case "acceptAll":
        await this.acceptAll();
        break;
      case "rejectAll":
        await this.rejectAll();
        break;
      case "acceptFile":
        await this.acceptFile(message.path);
        break;
      case "rejectFile":
        await this.rejectFileByPath(message.path);
        break;
      case "acceptHunk":
        await this.acceptHunk(message.path, message.hunkHash);
        break;
      case "rejectHunk":
        await this.rejectHunkByHash(message.path, message.hunkHash);
        break;
      case "openFile":
        await this.openFile(message.path);
        break;
      case "initGit":
        await this.initGit();
        break;
    }
  }

  private async initGit(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    const confirm = await vscode.window.showInformationMessage(
      `Initialize a Git repository in "${folder.name}"? This runs "git init" so agent changes can be reviewed and reverted.`,
      { modal: true },
      "Initialize"
    );
    if (confirm !== "Initialize") {
      return;
    }
    try {
      await gitInit(folder.uri.fsPath);
      vscode.window.showInformationMessage(
        "Initialized Git repository. Consider adding a .gitignore (e.g. for node_modules) so it isn't tracked."
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        `Could not initialize Git: ${this.describeError(err)}`
      );
    }
    await this.refresh();
  }

  public async newSession(): Promise<void> {
    if (this.repoRoot) {
      try {
        await clearTimeline(this.repoRoot);
      } catch {
        // Timeline may not exist; ignore.
      }
    }
    await this.context.workspaceState.update(SESSION_STATE_KEY, Date.now());
    await this.context.workspaceState.update(REVIEWED_STATE_KEY, {});
    await this.context.workspaceState.update(TIMELINE_REVIEWED_KEY, undefined);
    vscode.window.showInformationMessage(
      "Started a new review session. Your next agent request will be reviewed fresh."
    );
    await this.refresh();
  }

  public async acceptAll(): Promise<void> {
    if (this.files.length === 0) {
      await this.refresh();
    }
    if (this.files.length === 0) {
      return;
    }
    const reviewed: ReviewedMap = {};
    for (const file of this.files) {
      this.markFileReviewed(reviewed, file);
    }
    await this.setModeReviewed(reviewed);
    await this.refresh();
  }

  public async rejectAll(): Promise<void> {
    if (this.files.length === 0) {
      await this.refresh();
    }
    if (this.files.length === 0 || !this.repoRoot) {
      return;
    }

    if (this.mode === "timeline" && this.interaction) {
      await this.rejectAllTimeline(this.repoRoot, this.interaction);
      return;
    }

    const count = this.files.length;
    const confirm = await vscode.window.showWarningMessage(
      `Reject ALL changes in ${count} file${count === 1 ? "" : "s"}? ` +
        "This reverts tracked files to their last committed state and deletes new/untracked files.",
      { modal: true },
      "Reject All"
    );
    if (confirm !== "Reject All") {
      return;
    }

    const failures: string[] = [];
    for (const file of this.files) {
      try {
        await rejectFile(this.repoRoot, file);
      } catch (err) {
        failures.push(`${file.path}: ${this.describeError(err)}`);
      }
    }

    await this.context.workspaceState.update(REVIEWED_STATE_KEY, {});

    if (failures.length) {
      vscode.window.showErrorMessage(
        `Rejected with ${failures.length} failure(s):\n${failures.join("\n")}`
      );
    } else {
      vscode.window.showInformationMessage(`Rejected all changes in ${count} file(s).`);
    }
    await this.refresh();
  }

  private async rejectAllTimeline(
    repoRoot: string,
    interaction: Interaction
  ): Promise<void> {
    const count = this.files.length;
    const confirm = await vscode.window.showWarningMessage(
      `Reject ALL changes from your last request in ${count} file${
        count === 1 ? "" : "s"
      }? This restores them to how they were before the agent's latest request.`,
      { modal: true },
      "Reject All"
    );
    if (confirm !== "Reject All") {
      return;
    }

    const failures: string[] = [];
    for (const file of this.files) {
      try {
        await rejectInteractionFile(repoRoot, interaction, file.path);
      } catch (err) {
        failures.push(`${file.path}: ${this.describeError(err)}`);
      }
    }

    await this.setTimelineReviewed(interaction.id, {});

    if (failures.length) {
      vscode.window.showErrorMessage(
        `Rejected with ${failures.length} failure(s):\n${failures.join("\n")}`
      );
    } else {
      vscode.window.showInformationMessage(`Rejected all changes in ${count} file(s).`);
    }
    await this.refresh();
  }

  private async acceptFile(filePath: string): Promise<void> {
    const file = this.files.find((f) => f.path === filePath);
    if (!file) {
      await this.refresh();
      return;
    }
    const reviewed = this.getModeReviewed();
    this.markFileReviewed(reviewed, file);
    await this.setModeReviewed(reviewed);
    await this.refresh();
  }

  private async acceptHunk(filePath: string, hunkHash: string): Promise<void> {
    const file = this.files.find((f) => f.path === filePath);
    if (!file) {
      await this.refresh();
      return;
    }
    const hunk = file.hunks.find((h) => hashHunk(h) === hunkHash);
    if (!hunk) {
      await this.refresh();
      return;
    }
    const reviewed = this.getModeReviewed();
    const list = reviewed[filePath] ?? [];
    if (!list.includes(hunkHash)) {
      list.push(hunkHash);
    }
    reviewed[filePath] = list;
    await this.setModeReviewed(reviewed);
    await this.refresh();
  }

  private async rejectFileByPath(filePath: string): Promise<void> {
    const file = this.files.find((f) => f.path === filePath);
    if (!file || !this.repoRoot) {
      await this.refresh();
      return;
    }

    if (this.mode === "timeline" && this.interaction) {
      const confirm = await vscode.window.showWarningMessage(
        `Reject changes to "${file.path}" from this request? ` +
          "This restores the file to how it was before the agent's latest request.",
        { modal: true },
        "Reject"
      );
      if (confirm !== "Reject") {
        return;
      }
      try {
        await rejectInteractionFile(this.repoRoot, this.interaction, filePath);
        const reviewed = this.getTimelineReviewed(this.interaction.id);
        delete reviewed[filePath];
        await this.setTimelineReviewed(this.interaction.id, reviewed);
        vscode.window.showInformationMessage(`Reverted "${file.path}".`);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Could not reject "${file.path}": ${this.describeError(err)}`
        );
      }
      await this.refresh();
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Reject changes to "${file.path}"? This reverts the file to its last committed state.`,
      { modal: true },
      "Reject"
    );
    if (confirm !== "Reject") {
      return;
    }

    try {
      await rejectFile(this.repoRoot, file);
      const reviewed = this.getReviewedMap();
      delete reviewed[filePath];
      await this.context.workspaceState.update(REVIEWED_STATE_KEY, reviewed);
      vscode.window.showInformationMessage(`Reverted "${file.path}".`);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Could not reject "${file.path}": ${this.describeError(err)}`
      );
    }
    await this.refresh();
  }

  private async rejectHunkByHash(filePath: string, hunkHash: string): Promise<void> {
    const file = this.files.find((f) => f.path === filePath);
    const hunk = file?.hunks.find((h) => hashHunk(h) === hunkHash);
    if (!file || !hunk || !this.repoRoot) {
      vscode.window.showWarningMessage(
        "This hunk is no longer available. Refreshing the review."
      );
      await this.refresh();
      return;
    }

    try {
      await rejectHunk(this.repoRoot, file, hunk);
    } catch (err) {
      vscode.window.showErrorMessage(
        "Could not reject this hunk because the file changed while reviewing. " +
          "Please refresh and try again.\n" +
          this.describeError(err)
      );
    }
    await this.refresh();
  }

  private async openFile(filePath: string): Promise<void> {
    if (!this.repoRoot) {
      return;
    }
    const uri = vscode.Uri.file(path.join(this.repoRoot, filePath));
    try {
      await vscode.window.showTextDocument(uri, { preview: true });
    } catch {
      // File may not exist (deleted); ignore.
    }
  }

  private getReviewedMap(): ReviewedMap {
    const raw = this.context.workspaceState.get<ReviewedMap>(REVIEWED_STATE_KEY) ?? {};
    return cloneReviewed(raw);
  }

  /** Reviewed marks for one interaction; empty when the id has changed. */
  private getTimelineReviewed(interactionId: string): ReviewedMap {
    const raw = this.context.workspaceState.get<{ id: string; map: ReviewedMap }>(
      TIMELINE_REVIEWED_KEY
    );
    if (!raw || raw.id !== interactionId) {
      return {};
    }
    return cloneReviewed(raw.map);
  }

  private async setTimelineReviewed(
    interactionId: string,
    map: ReviewedMap
  ): Promise<void> {
    await this.context.workspaceState.update(TIMELINE_REVIEWED_KEY, {
      id: interactionId,
      map,
    });
  }

  private getModeReviewed(): ReviewedMap {
    return this.mode === "timeline" && this.interaction
      ? this.getTimelineReviewed(this.interaction.id)
      : this.getReviewedMap();
  }

  private async setModeReviewed(map: ReviewedMap): Promise<void> {
    if (this.mode === "timeline" && this.interaction) {
      await this.setTimelineReviewed(this.interaction.id, map);
    } else {
      await this.context.workspaceState.update(REVIEWED_STATE_KEY, map);
    }
  }

  private markFileReviewed(reviewed: ReviewedMap, file: ChangedFile): void {
    reviewed[file.path] =
      file.hunks.length === 0
        ? ["file:" + hashText(file.diff)]
        : file.hunks.map((h) => hashHunk(h));
  }

  /**
   * Watch the repo's timeline file so the panel refreshes when the hook records
   * a new interaction — including the first one, which flips worktree -> timeline
   * mode. Uses fs.watchFile because VS Code's watcher excludes `.git`.
   */
  private async ensureTimelineWatcher(repoRoot: string): Promise<void> {
    let timelinePath: string;
    try {
      timelinePath = await getTimelinePath(repoRoot);
    } catch {
      return;
    }
    if (this.watchedTimelinePath === timelinePath) {
      return;
    }
    this.stopWatchingTimeline();
    this.watchedTimelinePath = timelinePath;
    this.timelineListener = () => void this.refresh();
    fs.watchFile(timelinePath, { interval: 700 }, this.timelineListener);
  }

  private stopWatchingTimeline(): void {
    if (this.watchedTimelinePath && this.timelineListener) {
      fs.unwatchFile(this.watchedTimelinePath, this.timelineListener);
    }
    this.watchedTimelinePath = undefined;
    this.timelineListener = undefined;
  }

  private post(message: object): void {
    void this.panel.webview.postMessage(message);
  }

  private describeError(err: unknown): string {
    if (err instanceof GitError) {
      return (err.stderr || err.message).trim();
    }
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }

  public dispose(): void {
    ReviewPanel.current = undefined;
    this.stopWatchingTimeline();
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private getHtml(): string {
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 0;
    margin: 0;
  }
  header {
    position: sticky;
    top: 0;
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    padding: 10px 16px;
    display: flex;
    align-items: center;
    gap: 8px;
    z-index: 2;
  }
  header h1 { font-size: 13px; font-weight: 600; margin: 0; flex: 1; }
  .count { opacity: 0.7; font-weight: 400; }
  button {
    font-family: inherit;
    font-size: 12px;
    border: none;
    border-radius: 3px;
    padding: 3px 9px;
    cursor: pointer;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  .banner {
    padding: 8px 16px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .banner .ask { color: var(--vscode-descriptionForeground); }
  .banner .prompt { font-weight: 600; }
  #content { padding: 12px 16px 40px; }
  .file { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 14px; overflow: hidden; }
  .file.reviewed { opacity: 0.55; }
  .file-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .file-name { flex: 1; font-family: var(--vscode-editor-font-family); font-size: 12px; cursor: pointer; }
  .file-name:hover { text-decoration: underline; }
  .badge {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 1px 6px;
    border-radius: 8px;
    border: 1px solid var(--vscode-panel-border);
    opacity: 0.85;
  }
  .badge.added { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .badge.deleted { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .badge.renamed { color: var(--vscode-gitDecoration-renamedResourceForeground); }
  .badge.untracked { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
  .badge.reviewed { color: var(--vscode-testing-iconPassed, #3fb950); border-color: currentColor; }
  .hunk { border-top: 1px solid var(--vscode-panel-border); }
  .hunk:first-child { border-top: none; }
  .hunk.reviewed { opacity: 0.55; }
  .hunk.selected { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
  .hunk-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: var(--vscode-editor-background);
  }
  .hunk-bar .spacer { flex: 1; }
  pre.diff {
    margin: 0;
    padding: 4px 0;
    overflow-x: auto;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size, 12px);
    line-height: 1.45;
  }
  .diff .line { display: block; padding: 0 10px; white-space: pre; }
  .diff .add { background: var(--vscode-diffEditor-insertedTextBackground, rgba(63,185,80,0.15)); }
  .diff .del { background: var(--vscode-diffEditor-removedTextBackground, rgba(248,81,73,0.15)); }
  .diff .hunkhdr { color: var(--vscode-descriptionForeground); opacity: 0.8; }
  .diff .meta { color: var(--vscode-descriptionForeground); opacity: 0.6; }
  .empty, .error { padding: 40px 16px; text-align: center; color: var(--vscode-descriptionForeground); }
  .note { padding: 8px 10px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .group-header {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    margin: 6px 2px 8px;
  }
  .error { color: var(--vscode-errorForeground); }
  footer {
    position: sticky;
    bottom: 0;
    background: var(--vscode-editor-background);
    border-top: 1px solid var(--vscode-panel-border);
    padding: 5px 16px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
  }
</style>
</head>
<body>
  <header>
    <h1>Agent Change Review <span class="count" id="count"></span></h1>
    <button id="newSession" class="secondary" title="Start a new review session">New Session</button>
    <button id="acceptAll" class="secondary" title="Accept all (Alt+A)">Accept All</button>
    <button id="rejectAll" title="Reject all (Alt+Shift+R)">Reject All</button>
    <button id="refresh" class="secondary" title="Refresh (Alt+R)">Refresh</button>
  </header>
  <div id="banner" class="banner" style="display:none"></div>
  <div id="content"><div class="empty">Loading…</div></div>
  <footer id="hint">j/k or ↑/↓ select hunk &nbsp;·&nbsp; a accept &nbsp;·&nbsp; r reject &nbsp;·&nbsp; shift+a/r whole file</footer>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const content = document.getElementById('content');
    const countEl = document.getElementById('count');
    const banner = document.getElementById('banner');

    function showBanner(prompt) {
      banner.innerHTML = '';
      banner.appendChild(el('span', 'ask', 'You asked: '));
      banner.appendChild(el('span', 'prompt', prompt && prompt.length ? '“' + prompt + '”' : '(your latest request)'));
      banner.style.display = 'block';
    }

    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    document.getElementById('newSession').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    document.getElementById('acceptAll').addEventListener('click', () => vscode.postMessage({ type: 'acceptAll' }));
    document.getElementById('rejectAll').addEventListener('click', () => vscode.postMessage({ type: 'rejectAll' }));

    function el(tag, className, text) {
      const e = document.createElement(tag);
      if (className) e.className = className;
      if (text !== undefined) e.textContent = text;
      return e;
    }

    function classifyLine(raw) {
      if (raw.startsWith('@@')) return 'hunkhdr';
      if (raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('--- ') ||
          raw.startsWith('+++ ') || raw.startsWith('new file') || raw.startsWith('deleted file') ||
          raw.startsWith('rename ') || raw.startsWith('similarity ') || raw.startsWith('Binary ')) return 'meta';
      if (raw.startsWith('+')) return 'add';
      if (raw.startsWith('-')) return 'del';
      return '';
    }

    function renderDiff(text) {
      const pre = el('pre', 'diff');
      for (const raw of text.split('\\n')) {
        const line = el('span', 'line');
        line.textContent = raw.length ? raw : ' ';
        const cls = classifyLine(raw);
        if (cls) line.classList.add(cls);
        pre.appendChild(line);
      }
      return pre;
    }

    function renderHunk(file, hunk) {
      const wrap = el('div', 'hunk' + (hunk.reviewed ? ' reviewed' : ''));
      wrap.dataset.path = file.path;
      wrap.dataset.hash = hunk.hash;
      if (file.hunkActions) wrap.dataset.actionable = '1';
      if (file.hunkActions) {
        const bar = el('div', 'hunk-bar');
        bar.appendChild(el('span', 'spacer'));
        if (hunk.reviewed) bar.appendChild(el('span', 'badge reviewed', 'reviewed'));
        const accept = el('button', 'secondary', hunk.reviewed ? 'Accepted' : 'Accept hunk');
        accept.disabled = hunk.reviewed;
        accept.addEventListener('click', () => vscode.postMessage({ type: 'acceptHunk', path: file.path, hunkHash: hunk.hash }));
        const reject = el('button', '', 'Reject hunk');
        reject.addEventListener('click', () => vscode.postMessage({ type: 'rejectHunk', path: file.path, hunkHash: hunk.hash }));
        bar.appendChild(accept);
        bar.appendChild(reject);
        wrap.appendChild(bar);
      }
      wrap.appendChild(renderDiff(hunk.text));
      return wrap;
    }

    function renderFile(file) {
      const wrap = el('div', 'file' + (file.reviewed ? ' reviewed' : ''));

      const head = el('div', 'file-head');
      const name = el('span', 'file-name', file.oldPath ? (file.oldPath + ' → ' + file.path) : file.path);
      name.title = 'Open file';
      name.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: file.path }));
      head.appendChild(name);

      head.appendChild(el('span', 'badge ' + file.status, file.status));
      if (file.reviewed) head.appendChild(el('span', 'badge reviewed', 'reviewed'));

      const accept = el('button', 'secondary', file.reviewed ? 'Accepted' : 'Accept file');
      accept.disabled = file.reviewed;
      accept.addEventListener('click', () => vscode.postMessage({ type: 'acceptFile', path: file.path }));
      const reject = el('button', '', 'Reject file');
      reject.addEventListener('click', () => vscode.postMessage({ type: 'rejectFile', path: file.path }));
      head.appendChild(accept);
      head.appendChild(reject);
      wrap.appendChild(head);

      if (file.binary) {
        wrap.appendChild(el('div', 'note', 'Binary file — diff not shown.'));
      } else if (file.hunks.length === 0) {
        wrap.appendChild(el('div', 'note', 'No textual changes.'));
      } else {
        if (file.untracked) {
          wrap.appendChild(el('div', 'note', 'Untracked file — hunk-level reject is not supported; use Reject file to delete it.'));
        }
        for (const hunk of file.hunks) wrap.appendChild(renderHunk(file, hunk));
      }
      return wrap;
    }

    let hunkEls = [];
    let selected = -1;

    function applySelection() {
      hunkEls.forEach((e, i) => e.classList.toggle('selected', i === selected));
      if (selected >= 0 && hunkEls[selected]) {
        hunkEls[selected].scrollIntoView({ block: 'nearest' });
      }
    }

    function rebuildSelection() {
      hunkEls = Array.from(document.querySelectorAll('.hunk[data-actionable="1"]'));
      selected = hunkEls.length ? 0 : -1;
      applySelection();
    }

    function move(delta) {
      if (!hunkEls.length) return;
      selected = Math.max(0, Math.min(hunkEls.length - 1, (selected < 0 ? 0 : selected + delta)));
      applySelection();
    }

    function actOnSelected(type) {
      if (selected < 0 || !hunkEls[selected]) return;
      const e = hunkEls[selected];
      if (type === 'acceptHunk' || type === 'rejectHunk') {
        vscode.postMessage({ type, path: e.dataset.path, hunkHash: e.dataset.hash });
      } else {
        vscode.postMessage({ type, path: e.dataset.path });
      }
    }

    document.addEventListener('keydown', (event) => {
      // Let VS Code handle modified chords (Alt+A/Alt+R/etc.).
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      switch (event.key) {
        case 'j': case 'ArrowDown': move(1); event.preventDefault(); break;
        case 'k': case 'ArrowUp': move(-1); event.preventDefault(); break;
        case 'a': actOnSelected('acceptHunk'); event.preventDefault(); break;
        case 'r': actOnSelected('rejectHunk'); event.preventDefault(); break;
        case 'A': actOnSelected('acceptFile'); event.preventDefault(); break;
        case 'R': actOnSelected('rejectFile'); event.preventDefault(); break;
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      content.innerHTML = '';
      if (msg.type === 'render') {
        countEl.textContent = '(' + msg.files.length + ')';
        if (msg.mode === 'timeline') {
          showBanner(msg.prompt);
          for (const file of msg.files) content.appendChild(renderFile(file));
        } else {
          banner.style.display = 'none';
          const session = msg.files.filter((f) => f.session);
          const earlier = msg.files.filter((f) => !f.session);
          if (session.length && earlier.length) {
            content.appendChild(el('div', 'group-header', 'This session (' + session.length + ')'));
            for (const file of session) content.appendChild(renderFile(file));
            content.appendChild(el('div', 'group-header', 'Earlier changes (' + earlier.length + ')'));
            for (const file of earlier) content.appendChild(renderFile(file));
          } else {
            for (const file of msg.files) content.appendChild(renderFile(file));
          }
        }
        rebuildSelection();
      } else if (msg.type === 'empty') {
        banner.style.display = 'none';
        countEl.textContent = '';
        const box = el('div', 'empty');
        box.appendChild(el('div', '', msg.reason));
        if (msg.action === 'initGit') {
          const btn = el('button', '', 'Initialize Git Repository');
          btn.style.marginTop = '12px';
          btn.addEventListener('click', () => vscode.postMessage({ type: 'initGit' }));
          box.appendChild(btn);
        }
        content.appendChild(box);
        rebuildSelection();
      } else if (msg.type === 'error') {
        banner.style.display = 'none';
        countEl.textContent = '';
        content.appendChild(el('div', 'error', msg.message));
        rebuildSelection();
      }
    });

    vscode.postMessage({ type: 'refresh' });
  </script>
</body>
</html>`;
  }
}

function cloneReviewed(raw: ReviewedMap): ReviewedMap {
  const copy: ReviewedMap = {};
  for (const [k, v] of Object.entries(raw)) {
    copy[k] = [...v];
  }
  return copy;
}

/** Truncate long prompt text for compact display. */
function clip(text: string, max = 80): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function hashHunk(hunk: Hunk): string {
  return hashText(hunk.lines.join("\n"));
}

function hashText(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}
