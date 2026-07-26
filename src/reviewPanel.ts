import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { GitError, PatchConflictError, gitInit, rejectHunk } from "./git";
import { installHook } from "./hookInstall";
import { compileIgnore } from "./ignore";
import { discoverRepos, invalidateRepoCache } from "./repoResolver";
import {
  buildRenderModel,
  fileKey,
  hashHunk,
  markFileAccepted,
  markFileRejected,
  markHunkAccepted,
  markHunkRejected,
  pendingHunks,
} from "./reviewModel";
import {
  clearTimeline,
  getInteractionDiff,
  getTimelinePath,
  hardRestoreInteractionFile,
  readLatestInteraction,
  rejectInteractionFile,
} from "./timeline";
import {
  AggregatedInteraction,
  InboundMessage,
  RenderFile,
  RepoFile,
  ReviewMap,
} from "./types";

const REVIEWED_STATE_KEY = "agentChangeReview.timelineReviewed";

function getIgnorePredicate(): (relativePath: string) => boolean {
  const patterns = vscode.workspace
    .getConfiguration("agentChangeReview")
    .get<string[]>("ignore", []);
  return compileIgnore(patterns);
}

/** Whether the agent's latest request has anything left to review. */
export async function hasPendingReview(): Promise<boolean> {
  try {
    const repos = await discoverRepos();
    if (!repos.length) {
      return false;
    }
    const interaction = await readLatestInteraction(repos);
    if (!interaction) {
      return false;
    }
    const ignore = getIgnorePredicate();
    const files = (await getInteractionDiff(interaction)).filter(
      (f) => !ignore(f.path)
    );
    return files.length > 0;
  } catch {
    return false;
  }
}

export class ReviewPanel {
  public static current: ReviewPanel | undefined;
  private static readonly viewType = "agentChangeReview";

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];
  private files: RepoFile[] = [];
  private interaction: AggregatedInteraction | null = null;
  private repos: string[] = [];
  /** timeline.jsonl path -> its fs.watchFile listener, one per repo. */
  private timelineWatchers = new Map<string, () => void>();

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
      { enableScripts: true, retainContextWhenHidden: true }
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
    if (!vscode.workspace.workspaceFolders?.length) {
      this.post({ type: "empty", reason: "Open a folder to review agent changes." });
      return;
    }

    try {
      this.repos = await discoverRepos();
    } catch (err) {
      this.post({ type: "error", message: this.describeError(err) });
      return;
    }

    if (!this.repos.length) {
      // Nothing is a repo at or below the workspace, so `git init` here cannot
      // nest an existing repo.
      this.post({
        type: "empty",
        reason:
          "This folder isn't a Git repository. Agent Change Review uses Git to snapshot and revert agent changes.",
        action: "initGit",
      });
      return;
    }

    await this.ensureTimelineWatchers(this.repos);

    try {
      this.interaction = await readLatestInteraction(this.repos);
    } catch (err) {
      this.post({ type: "error", message: this.describeError(err) });
      return;
    }

    if (!this.interaction) {
      this.post({
        type: "empty",
        reason:
          "No agent changes recorded yet. Make a request in Claude Code and it will show up here.",
        action: "installHook",
      });
      return;
    }

    try {
      const ignore = getIgnorePredicate();
      this.files = (await getInteractionDiff(this.interaction)).filter(
        (f) => !ignore(f.path)
      );
    } catch (err) {
      this.post({ type: "error", message: this.describeError(err) });
      return;
    }

    if (!this.files.length) {
      const asked = this.interaction.prompt ? ` ("${clip(this.interaction.prompt)}")` : "";
      this.post({
        type: "empty",
        reason: `Nothing left to review from your last request${asked}. Waiting for the next one…`,
      });
      return;
    }

    this.post({
      type: "render",
      files: await this.buildRenderFiles(this.interaction),
      interactionTs: this.interaction.ts,
      multiRepo: new Set(this.files.map((f) => f.repoRoot)).size > 1,
    });
  }

  /** Build the render model and prune review marks that no longer apply. */
  private async buildRenderFiles(
    interaction: AggregatedInteraction
  ): Promise<RenderFile[]> {
    const { render, pruned } = buildRenderModel(
      this.files,
      this.getReviewMap(interaction.id)
    );
    await this.setReviewMap(interaction.id, pruned);
    return render;
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    switch (message.type) {
      case "refresh":
        // A user-initiated refresh should also re-detect repos.
        invalidateRepoCache();
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
        await this.acceptFile(message.repoRoot, message.path);
        break;
      case "rejectFile":
        await this.rejectFileByPath(message.repoRoot, message.path);
        break;
      case "acceptHunk":
        await this.acceptHunk(message.repoRoot, message.path, message.hunkHash);
        break;
      case "rejectHunk":
        await this.rejectHunkByHash(message.repoRoot, message.path, message.hunkHash);
        break;
      case "openFile":
        await this.openFile(message.repoRoot, message.path);
        break;
      case "initGit":
        await this.initGit();
        break;
      case "installHook":
        await installHook(this.context);
        break;
    }
  }

  public async newSession(): Promise<void> {
    try {
      await clearTimeline(this.repos);
    } catch {
      // Timelines may not exist; ignore.
    }
    await this.context.workspaceState.update(REVIEWED_STATE_KEY, undefined);
    vscode.window.showInformationMessage(
      "Started a new review session. Your next agent request will be reviewed fresh."
    );
    await this.refresh();
  }

  public async acceptAll(): Promise<void> {
    if (!this.files.length || !this.interaction) {
      return;
    }
    const review = this.getReviewMap(this.interaction.id);
    for (const file of this.files) {
      markFileAccepted(review, file);
    }
    await this.setReviewMap(this.interaction.id, review);
    await this.refresh();
  }

  public async rejectAll(): Promise<void> {
    if (!this.files.length || !this.interaction) {
      return;
    }
    const interaction = this.interaction;
    const count = this.files.length;
    const confirm = await vscode.window.showWarningMessage(
      `Reject the agent's changes in all ${count} file${count === 1 ? "" : "s"}?`,
      { modal: true },
      "Reject All"
    );
    if (confirm !== "Reject All") {
      return;
    }

    const review = this.getReviewMap(interaction.id);
    const conflicted: string[] = [];
    const failures: string[] = [];
    for (const file of this.files) {
      try {
        await rejectInteractionFile(
          interaction,
          file.repoRoot,
          file,
          pendingHunks(file, review)
        );
        markFileRejected(review, file);
      } catch (err) {
        // Leave conflicted files listed and unmarked, so they can still be dealt with.
        if (err instanceof PatchConflictError) {
          conflicted.push(file.path);
        } else {
          failures.push(`${file.path}: ${this.describeError(err)}`);
        }
      }
    }

    await this.setReviewMap(interaction.id, review);
    if (failures.length) {
      vscode.window.showErrorMessage(
        `Rejected with ${failures.length} failure(s):\n${failures.join("\n")}`
      );
    } else if (conflicted.length) {
      // Reported together rather than prompting mid-loop for each one.
      vscode.window.showWarningMessage(
        `Rejected ${count - conflicted.length} of ${count} file(s). ` +
          `These changed since the agent edited them, so their changes were left alone — ` +
          `reject them individually to decide: ${conflicted.join(", ")}`
      );
    } else {
      vscode.window.showInformationMessage(
        `Undid the agent's changes in ${count} file(s).`
      );
    }
    await this.refresh();
  }

  private async acceptFile(repoRoot: string, filePath: string): Promise<void> {
    const file = this.findFile(repoRoot, filePath);
    if (!file || !this.interaction) {
      await this.refresh();
      return;
    }
    const review = this.getReviewMap(this.interaction.id);
    markFileAccepted(review, file);
    await this.setReviewMap(this.interaction.id, review);
    await this.refresh();
  }

  private async acceptHunk(
    repoRoot: string,
    filePath: string,
    hunkHash: string
  ): Promise<void> {
    const file = this.findFile(repoRoot, filePath);
    const hunk = file?.hunks.find((h) => hashHunk(h) === hunkHash);
    if (!file || !hunk || !this.interaction) {
      await this.refresh();
      return;
    }
    const review = this.getReviewMap(this.interaction.id);
    markHunkAccepted(review, fileKey(repoRoot, filePath), hunkHash);
    await this.setReviewMap(this.interaction.id, review);
    await this.refresh();
  }

  private async rejectFileByPath(repoRoot: string, filePath: string): Promise<void> {
    const file = this.findFile(repoRoot, filePath);
    if (!file || !this.interaction) {
      await this.refresh();
      return;
    }
    const interaction = this.interaction;

    const confirm = await vscode.window.showWarningMessage(
      `Reject the agent's changes to "${file.path}"?`,
      { modal: true },
      "Reject"
    );
    if (confirm !== "Reject") {
      return;
    }

    try {
      const pending = pendingHunks(file, this.getReviewMap(interaction.id));
      await rejectInteractionFile(interaction, repoRoot, file, pending);
      await this.recordFileRejected(interaction.id, file);
      vscode.window.showInformationMessage(`Undid the agent's changes to "${file.path}".`);
    } catch (err) {
      if (err instanceof PatchConflictError) {
        await this.offerHardRestore(interaction, file);
      } else {
        vscode.window.showErrorMessage(
          `Could not reject "${file.path}": ${this.describeError(err)}`
        );
      }
    }
    await this.refresh();
  }

  /**
   * The agent's change couldn't be undone on its own because the user edited the
   * same lines. Offer the blunt restore, naming the cost, rather than silently
   * discarding their edits.
   */
  private async offerHardRestore(
    interaction: AggregatedInteraction,
    file: RepoFile
  ): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `"${file.path}" changed since the agent edited it, so the agent's change can't be undone on its own.`,
      {
        modal: true,
        detail:
          "Restore the file to how it was before the request? Your own edits to this file will be discarded too.",
      },
      "Restore"
    );
    if (choice !== "Restore") {
      return;
    }
    try {
      await hardRestoreInteractionFile(interaction, file.repoRoot, file.path);
      await this.recordFileRejected(interaction.id, file);
      vscode.window.showInformationMessage(`Restored "${file.path}".`);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Could not restore "${file.path}": ${this.describeError(err)}`
      );
    }
  }

  private async recordFileRejected(
    interactionId: string,
    file: RepoFile
  ): Promise<void> {
    const review = this.getReviewMap(interactionId);
    markFileRejected(review, file);
    await this.setReviewMap(interactionId, review);
  }

  private async rejectHunkByHash(
    repoRoot: string,
    filePath: string,
    hunkHash: string
  ): Promise<void> {
    const file = this.findFile(repoRoot, filePath);
    const hunk = file?.hunks.find((h) => hashHunk(h) === hunkHash);
    if (!file || !hunk || !this.interaction) {
      vscode.window.showWarningMessage(
        "This hunk is no longer available. Refreshing the review."
      );
      await this.refresh();
      return;
    }

    try {
      await rejectHunk(repoRoot, file, hunk);
      // The rendered diff is frozen, so it cannot show that this hunk is gone;
      // record the decision so it stops being offered for review.
      const review = this.getReviewMap(this.interaction.id);
      markHunkRejected(review, fileKey(repoRoot, filePath), hunkHash);
      await this.setReviewMap(this.interaction.id, review);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Could not reject this hunk: "${file.path}" changed since the agent edited it, ` +
          "so this hunk no longer applies cleanly. Refresh and try again, or reject the whole file.\n" +
          this.describeError(err)
      );
    }
    await this.refresh();
  }

  private async openFile(repoRoot: string, filePath: string): Promise<void> {
    const uri = vscode.Uri.file(path.join(repoRoot, filePath));
    try {
      await vscode.window.showTextDocument(uri, { preview: true });
    } catch {
      // File may not exist (deleted); ignore.
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
      invalidateRepoCache();
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

  private findFile(repoRoot: string, filePath: string): RepoFile | undefined {
    return this.files.find((f) => f.repoRoot === repoRoot && f.path === filePath);
  }

  /** Review marks for one interaction; empty once the request changes. */
  private getReviewMap(interactionId: string): ReviewMap {
    const raw = this.context.workspaceState.get<{ id: string; map: ReviewMap }>(
      REVIEWED_STATE_KEY
    );
    if (!raw || raw.id !== interactionId || !raw.map) {
      return {};
    }
    const copy: ReviewMap = {};
    for (const [k, v] of Object.entries(raw.map)) {
      // Tolerate state written by an older version, which stored a bare array.
      if (!v || Array.isArray(v)) {
        continue;
      }
      copy[k] = {
        accepted: Array.isArray(v.accepted) ? [...v.accepted] : [],
        rejected: Array.isArray(v.rejected) ? [...v.rejected] : [],
      };
    }
    return copy;
  }

  private async setReviewMap(interactionId: string, map: ReviewMap): Promise<void> {
    await this.context.workspaceState.update(REVIEWED_STATE_KEY, {
      id: interactionId,
      map,
    });
  }

  /**
   * Watch every repo's timeline file, so a new request in any repo updates the
   * panel. Uses fs.watchFile because VS Code's watcher excludes `.git`.
   */
  private async ensureTimelineWatchers(repoRoots: string[]): Promise<void> {
    const wanted = new Set<string>();
    for (const repoRoot of repoRoots) {
      try {
        wanted.add(await getTimelinePath(repoRoot));
      } catch {
        // Repo may have gone away; skip it.
      }
    }

    for (const [timelinePath, listener] of this.timelineWatchers) {
      if (!wanted.has(timelinePath)) {
        fs.unwatchFile(timelinePath, listener);
        this.timelineWatchers.delete(timelinePath);
      }
    }

    for (const timelinePath of wanted) {
      if (this.timelineWatchers.has(timelinePath)) {
        continue;
      }
      const listener = () => void this.refresh();
      fs.watchFile(timelinePath, { interval: 700 }, listener);
      this.timelineWatchers.set(timelinePath, listener);
    }
  }

  private stopWatchingTimelines(): void {
    for (const [timelinePath, listener] of this.timelineWatchers) {
      fs.unwatchFile(timelinePath, listener);
    }
    this.timelineWatchers.clear();
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
    this.stopWatchingTimelines();
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
  .badge.reviewed { color: var(--vscode-testing-iconPassed, #3fb950); border-color: currentColor; }
  .badge.edited { color: var(--vscode-editorWarning-foreground, #cca700); border-color: currentColor; }
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
  <div id="content"><div class="empty">Loading…</div></div>
  <footer id="hint">j/k or ↑/↓ select hunk &nbsp;·&nbsp; a accept &nbsp;·&nbsp; r reject &nbsp;·&nbsp; shift+a/r whole file</footer>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const content = document.getElementById('content');
    const countEl = document.getElementById('count');

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
      wrap.dataset.repo = file.repoRoot;
      wrap.dataset.path = file.path;
      wrap.dataset.hash = hunk.hash;
      if (file.hunkActions) {
        wrap.dataset.actionable = '1';
        const bar = el('div', 'hunk-bar');
        bar.appendChild(el('span', 'spacer'));
        if (hunk.reviewed) bar.appendChild(el('span', 'badge reviewed', 'reviewed'));
        const accept = el('button', 'secondary', hunk.reviewed ? 'Accepted' : 'Accept hunk');
        accept.disabled = hunk.reviewed;
        accept.addEventListener('click', () => vscode.postMessage({ type: 'acceptHunk', repoRoot: file.repoRoot, path: file.path, hunkHash: hunk.hash }));
        const reject = el('button', '', 'Reject hunk');
        reject.addEventListener('click', () => vscode.postMessage({ type: 'rejectHunk', repoRoot: file.repoRoot, path: file.path, hunkHash: hunk.hash }));
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
      name.addEventListener('click', () => vscode.postMessage({ type: 'openFile', repoRoot: file.repoRoot, path: file.path }));
      head.appendChild(name);

      head.appendChild(el('span', 'badge ' + file.status, file.status));
      if (file.reviewed) head.appendChild(el('span', 'badge reviewed', 'reviewed'));
      if (file.editedSinceAgent) {
        const badge = el('span', 'badge edited', 'edited by you');
        badge.title = "You've changed this file since the agent did. The diff below is the agent's change only; rejecting undoes just that and keeps your edits.";
        head.appendChild(badge);
      }

      const accept = el('button', 'secondary', file.reviewed ? 'Accepted' : 'Accept file');
      accept.disabled = file.reviewed;
      accept.addEventListener('click', () => vscode.postMessage({ type: 'acceptFile', repoRoot: file.repoRoot, path: file.path }));
      const reject = el('button', '', 'Reject file');
      reject.addEventListener('click', () => vscode.postMessage({ type: 'rejectFile', repoRoot: file.repoRoot, path: file.path }));
      head.appendChild(accept);
      head.appendChild(reject);
      wrap.appendChild(head);

      if (file.binary) {
        wrap.appendChild(el('div', 'note', 'Binary file — diff not shown.'));
      } else if (file.hunks.length === 0) {
        wrap.appendChild(el('div', 'note', 'No textual changes.'));
      } else {
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
      const msg = { type, repoRoot: e.dataset.repo, path: e.dataset.path };
      if (type === 'acceptHunk' || type === 'rejectHunk') msg.hunkHash = e.dataset.hash;
      vscode.postMessage(msg);
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
        if (msg.multiRepo) {
          let current = null;
          for (const file of msg.files) {
            if (file.repo !== current) {
              current = file.repo;
              content.appendChild(el('div', 'group-header', current));
            }
            content.appendChild(renderFile(file));
          }
        } else {
          for (const file of msg.files) content.appendChild(renderFile(file));
        }
        rebuildSelection();
      } else if (msg.type === 'empty') {
        countEl.textContent = '';
        const box = el('div', 'empty');
        box.appendChild(el('div', '', msg.reason));
        if (msg.action === 'initGit' || msg.action === 'installHook') {
          const label = msg.action === 'initGit' ? 'Initialize Git Repository' : 'Install Claude Code Hook';
          const btn = el('button', '', label);
          btn.style.marginTop = '12px';
          btn.addEventListener('click', () => vscode.postMessage({ type: msg.action }));
          box.appendChild(btn);
        }
        content.appendChild(box);
        rebuildSelection();
      } else if (msg.type === 'error') {
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

/** Truncate long prompt text for compact display. */
function clip(text: string, max = 80): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}
