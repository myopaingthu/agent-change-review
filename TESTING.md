# Testing Agent Change Review in the F5 Dev Host

A step-by-step manual test guide for running the extension locally in VS Code's
**Extension Development Host**. No publishing required.

> The missing `media/icon.png` does **not** block F5 — it only matters at
> `vsce package` / publish time. Ignore any icon warning while testing.

---

## 1. Open the extension project

Open the `agent-change-review` folder itself (not a parent folder):

```bash
code /Users/htethtetoowai/projects/Personal/agent-change-review
```

## 2. (Optional) Start the watch compiler

So source edits recompile automatically:

**Terminal → Run Task → `npm: watch`**

Otherwise the F5 pre-launch task compiles once on each launch.

## 3. Press F5

Launches a second window titled **[Extension Development Host]** running the
extension. If prompted for a debug configuration, pick **Run Extension**.

> If F5 does nothing, make sure the original window has the extension folder open
> (the `.vscode/launch.json` lives there).

## 4. Open a test project in the dev-host window

In the **[Extension Development Host]** window, open any Git repo that has at
least one commit. To create a throwaway one:

```bash
mkdir -p ~/acr-test && cd ~/acr-test && git init && \
printf 'line1\nline2\nline3\n' > app.js && git add . && git commit -m init
```

Then File → Open Folder → `~/acr-test`.

For a good multi-hunk test, also create a longer file:

```bash
cd ~/acr-test && python3 -c "print('\n'.join(str(i) for i in range(1,31)))" > big.txt && \
git add big.txt && git commit -m "add big.txt"
```

## 5. Make some "agent-style" changes

- Modify `app.js` (change line 2).
- In `big.txt`, change **line 2** and **line 28** (far apart → two separate hunks).
- Create a new file `notes.md`.
- Delete or rename a file.

## 6. Open the panel

Command Palette (`Cmd+Shift+P`) → **Agent Change Review: Open Review Panel**.

You should see each changed file with its diff, status badges
(modified / added / untracked), and per-hunk + per-file **Accept / Reject** buttons.

---

## 7. Per-interaction (timeline) mode — the main new flow

This is the Cursor-style review. It needs the Claude Code hook and a real Claude
Code session (not just simulated file edits).

### 7.1 Install the hook
1. In the dev-host window (with `~/acr-test` open), run **Agent Change Review: Install Claude Code Hook**.
2. Accept the info message. It writes `~/.claude/acr/hook.js` and adds hooks to `~/acr-test/.claude/settings.local.json`.
3. **Restart the Claude Code session** for that folder so the hook loads.

### 7.2 The add-then-remove test (the key scenario)
1. Open the review panel and keep it visible.
2. Ask Claude Code: *"add a `// hello` comment at the top of app.js"*. When it finishes, the panel shows a `You asked: "…"` banner and the **addition** of `// hello`.
3. Ask Claude Code: *"remove that comment"*. When it finishes, the panel now shows the **removal** (`- // hello`) — **not** an empty view. The earlier addition is folded into the baseline.
4. ✅ Pass = step 3 shows the removal. (In the old model, `git diff HEAD` would be empty here.)

### 7.3 Agent vs human
1. While the panel shows an agent request, hand-edit a *different* file in the editor and save it.
2. ✅ Pass = your hand-edited file does **not** appear in the panel (only agent-touched files show).

### 7.4 Reject in timeline mode
1. On an agent change, click **Reject file** (or **Reject hunk**). The modal should mention restoring to "before the agent's latest request".
2. ✅ Pass = the file goes back to how it was *before that request*; a file the agent created this request is deleted.

### 7.5 New Session
1. Click **New Session**.
2. ✅ Pass = the panel returns to working-tree mode until your next request. `~/acr-test/.git/acr/timeline.jsonl` is gone and `git -C ~/acr-test show-ref | grep acr` shows nothing.

### 7.6 Uninstall
1. Run **Agent Change Review: Uninstall Claude Code Hook**.
2. ✅ Pass = the three hook entries are removed from `.claude/settings.local.json`.

> Nothing showing after a request? Make sure you restarted the Claude Code session
> after installing and that `node` is on your `PATH`. Inspect
> `~/acr-test/.git/acr/timeline.jsonl` — if it's missing, the hook didn't run.

---

## 8. Working-tree mode checklist (fallback, no hook)

### Phase 1 — file level
- [ ] Click a filename → the file opens in an editor.
- [ ] **Reject file** on the `app.js` edit → confirm modal → file reverts to
      committed content and leaves the list.
- [ ] **Accept file** → the file dims and shows a "reviewed" badge.

### Phase 2 — hunks (use `big.txt`)
- [ ] `big.txt` shows **two** hunks.
- [ ] **Reject hunk** on one hunk → only that change reverts; the other remains.
- [ ] **Accept hunk** → that hunk dims; the file is marked "reviewed" only once
      **all** its hunks are accepted.
- [ ] Error path: reject a hunk, then hand-edit the same file before the panel
      refreshes → you get a "file changed while reviewing" message, and the file
      is **not** corrupted.

### Phase 3 — bulk + keyboard
> Click **inside** the panel first so it has keyboard focus.
- [ ] `j` / `k` (or ↑ / ↓) move the highlighted hunk.
- [ ] `a` / `r` accept / reject the selected hunk.
- [ ] `Shift+A` / `Shift+R` accept / reject the selected hunk's whole file.
- [ ] `Alt+A` Accept All, `Alt+Shift+R` Reject All, `Alt+R` Refresh.
- [ ] **Accept All** / **Reject All** header buttons work (Reject All shows a
      confirm modal).

### Phase 4 — sessions / ignore / auto-open
- [ ] **Auto-refresh**: with the panel open, edit a file in the editor → the
      panel updates by itself (~0.5s).
- [ ] **New Session**: click **New Session**, then edit a file → it appears under
      **This session**, older edits under **Earlier changes**.
- [ ] **Ignore**: add the snippet below to the dev-host workspace settings, then
      Refresh → matching files disappear from the review.
- [ ] **Auto-open**: enable `autoOpen`, close the panel, edit a file → the panel
      pops open on its own.
- [ ] **URI handler**: run the command below in a terminal → the panel opens.

### Settings snippet (dev-host workspace `.vscode/settings.json`)

```json
{
  "agentChangeReview.ignore": ["**/*.log", "notes.md"],
  "agentChangeReview.autoOpen": true
}
```

### URI handler / Claude Code hook path

```bash
code --open-url "vscode://myopaingthu.agent-change-review/open"
code --open-url "vscode://myopaingthu.agent-change-review/refresh"
```

---

## 9. Iterating on code

After changing anything in `src/**`:

1. The `npm: watch` task recompiles (or F5 recompiles on relaunch).
2. In the **[Extension Development Host]** window, run
   **Developer: Reload Window** (`Cmd+R`) to load the new build.

## 10. Stop

Close the dev-host window, or press the **stop** button on the debug toolbar in
the main window.

---

## Troubleshooting

- **Command missing from the palette** → the extension failed to activate. Check
  the **Debug Console** in the main window for an activation error.
- **Watch the Debug Console** for runtime exceptions while clicking around; that's
  where extension-host errors surface.
- **"This folder isn't a Git repository"** → Git is required (it's how changes are
  snapshotted and reverted). Click **Initialize Git Repository** in the panel, or
  run `git init` yourself. An initial commit is optional.
- **Reject hunk fails** → the working tree changed since the diff was captured.
  Click **Refresh** and try again.
- **Panel stays in working-tree mode after installing the hook** → restart the
  Claude Code session so the hook loads, and confirm `node` is on your `PATH`.
  Check that `~/acr-test/.git/acr/timeline.jsonl` gets a new line after a request.
- **Timeline mode is "stuck"** → run **New Session** to clear the recorded
  timeline and return to a fresh baseline.
