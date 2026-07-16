# Testing Agent Change Review in the F5 Dev Host

A step-by-step manual test guide for running the extension locally in VS Code's
**Extension Development Host**. No publishing required.

> The missing `media/icon.png` does **not** block F5 — it only matters at
> `vsce package` / publish time. Ignore any icon warning while testing.

**What this extension shows:** only what the agent changed in its **latest
request**. It is not a list of uncommitted changes. Your own hand-edits, staged
files, and older agent requests never appear. If you see nothing, that's a real
signal the hook isn't recording — see Troubleshooting.

---

## 1. Open the extension project

Open the `agent-change-review` folder itself (not a parent folder):

```bash
code /Users/htethtetoowai/projects/Personal/agent-change-review
```

## 2. (Optional) Start the watch compiler

So source edits recompile automatically: **Terminal → Run Task → `npm: watch`**.
Otherwise the F5 pre-launch task compiles once on each launch.

## 3. Press F5

Launches a second window titled **[Extension Development Host]**. If prompted for
a debug configuration, pick **Run Extension**.

## 4. Create a multi-repo test workspace

This mirrors the real-world layout: a parent folder that is **not** a repo,
holding two repos.

```bash
rm -rf ~/acr-test && mkdir -p ~/acr-test/backend ~/acr-test/frontend
for d in backend frontend; do
  cd ~/acr-test/$d && git init -q && printf 'line1\nline2\nline3\n' > app.js \
    && git add . && git commit -qm init
done
```

In the dev-host window: **File → Open Folder → `~/acr-test`** (the parent).

## 5. Install the hook

1. Command Palette (`Cmd+Shift+P`) → **Agent Change Review: Install Claude Code Hook**.
2. It writes `~/.claude/acr/hook.js` and hooks into `~/acr-test/.claude/settings.local.json`.
3. **Restart your Claude Code session** in `~/acr-test` so it loads the hook.

## 6. Open the panel

Command Palette → **Agent Change Review: Open Review Panel**. Keep it open.
Before your first request it should say *"No agent changes recorded yet"* — not a
list of files.

---

## 7. Feature checklist

### 7.1 The add-then-remove test (the key scenario)
- [ ] Ask Claude Code: *"add a `// hello` comment at the top of backend/app.js"*.
      → panel shows a `You asked: "…"` banner and the **addition**.
- [ ] Ask: *"remove that comment"*.
      → panel shows the **removal** (`- // hello`), **not** an empty view, even
      though `git diff HEAD` in that repo is now empty.

### 7.2 Multi-repo in one request
- [ ] Ask: *"add a `// touched` comment to the top of app.js in **both** backend and frontend"*.
- [ ] Panel shows **both** files, under `backend` and `frontend` group headers.
- [ ] Note Claude Code is running from `~/acr-test`, which isn't a repo — it must still work.

### 7.3 Agent vs human
- [ ] Hand-edit a file yourself in the editor and save it.
- [ ] It does **not** appear in the panel (only agent-edited files show).

### 7.4 Reject / accept
- [ ] **Reject file** → the modal mentions "before the agent's latest request";
      the file reverts **and disappears from the list**.
- [ ] Reject a file the agent *created* → the file is deleted.
- [ ] **Reject hunk** on a multi-hunk change → only that hunk reverts.
- [ ] **Accept file / Accept All** → dims and marks reviewed (no file changes).
- [ ] Rejecting in `frontend` leaves `backend`'s changes untouched.

### 7.5 Keyboard
> Click inside the panel first so it has focus.
- [ ] `j`/`k` (or ↑/↓) move the selected hunk; `a`/`r` accept/reject it.
- [ ] `Shift+A`/`Shift+R` act on the whole file.
- [ ] `Alt+A` Accept All, `Alt+Shift+R` Reject All, `Alt+R` Refresh.

### 7.6 Reset / ignore / auto-open / uninstall
- [ ] **New Session** (Reset Review Baseline) → panel returns to "No agent changes
      recorded yet"; `~/acr-test/*/.git/acr/timeline.jsonl` is gone and
      `git -C ~/acr-test/backend show-ref | grep acr` shows nothing.
- [ ] **Ignore**: add the snippet below, Refresh → matching files disappear.
- [ ] **Auto-open**: enable `autoOpen`, close the panel, make a request → it opens itself.
- [ ] **Uninstall Claude Code Hook** → the four hook entries leave `.claude/settings.local.json`.

### Settings snippet (dev-host workspace `.vscode/settings.json`)

```json
{
  "agentChangeReview.ignore": ["**/*.log", "notes.md"],
  "agentChangeReview.autoOpen": true
}
```

---

## 8. Iterating on code

After changing anything in `src/**`:

1. The `npm: watch` task recompiles (or F5 recompiles on relaunch).
2. In the **[Extension Development Host]** window, run **Developer: Reload Window** (`Cmd+R`).

> If you changed `src/hookRunner.ts`, the new build is copied to
> `~/.claude/acr/hook.js` on activation — but Claude Code only re-reads hook
> *config* at session start. Restart the Claude session after changing which
> events are registered.

## 9. Stop

Close the dev-host window, or press **stop** on the debug toolbar.

---

## Troubleshooting

- **"No agent changes recorded yet" after a request** → the hook isn't running.
  Check, in order:
  1. Did you restart the Claude Code session after installing?
  2. Is `node` on your `PATH`? (the hook command is `node "~/.claude/acr/hook.js" …`)
  3. Does `~/acr-test/backend/.git/acr/timeline.jsonl` exist and grow after a request?
  4. Does `~/acr-test/.claude/settings.local.json` contain four ACR hook entries
     (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`)?
- **Command missing from the palette** → the extension failed to activate. Check
  the **Debug Console** in the main window for an activation error.
- **"This folder isn't a Git repository"** → no repo was found at or below the
  folder. Click **Initialize Git Repository**, or open a folder that contains one.
- **Reject hunk fails** → the file changed since the diff was captured. Click
  **Refresh** and try again.
- **Changes from a shell `rm`/`mv` don't show** → expected; the hook only sees the
  `Edit`/`Write` tools.
