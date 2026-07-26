# Changelog

## 0.3.0

Breaking rework of how changes are detected. **Re-run "Install Claude Code Hook" and restart your Claude Code session** — the hook now registers a new `PreToolUse` event.

- **Working-tree mode removed.** The panel now only ever shows the agent's latest request. It no longer falls back to listing your uncommitted changes, which previously masked a hook that wasn't recording at all.
- **The repo is derived from each edited file's path, not from Claude's `cwd`.** Fixes the case where the workspace root isn't a Git repo (e.g. a folder holding `backend/` and `frontend/`): the hook previously recorded *nothing at all* there.
- **One request can span multiple repos.** Edits to `backend/` and `frontend/` in a single request are merged into one review, grouped by repo. Previously everything outside the cwd's repo was silently dropped.
- Baselines are captured at `PreToolUse` (just before the agent's first edit to each repo), so every touched repo gets a correct pre-edit baseline.
- **One hunk per contiguous run of changed lines.** `git diff` welds changes into a single hunk whenever they're within 6 lines of each other, so unrelated edits could only be accepted or rejected as a group. Each run is now its own hunk, as in Cursor: two adjacent changed lines stay together, two separated ones are separate hunks.
- **Only the agent's own edits are ever shown.** The diff is taken between the two recorded checkpoints, so editing a file the agent touched no longer adds your edits to the review. Such a file is badged `edited by you`, since the diff shown is the agent's, not the file's current state.
- **Rejecting undoes only the agent's change and keeps your own edits**, by reverse-applying the agent's diff rather than restoring the whole file. If your edits overlap the agent's exact lines the change can't be undone on its own, and you're asked before falling back to a full restore.
- **The `You asked: "…"` prompt banner is gone.** The panel leads with the changes themselves. The hook still records the request text, so nothing about detection changes.
- Auto-open now triggers off recorded requests rather than raw file activity.

## 0.2.1

- **Multi-repo workspace support**: discovers every Git repo in the workspace (including `backend/` + `frontend/` under a non-Git parent, and multi-root workspaces) and follows whichever repo the agent worked in most recently
- Repo name shown in the banner when a workspace holds more than one repo
- Repo discovery reuses VS Code's own detection (Git extension API) with a shallow filesystem scan as a fallback
- Watches every repo's timeline, so an interaction in any repo updates the panel
- Non-Git folders now offer a one-click **Initialize Git Repository** instead of a dead-end message (only when no repo exists at or below the folder, so it can't nest an existing repo)

## 0.2.0

- **Per-interaction review (timeline mode)** for Claude Code: review only what the agent changed in its latest request, with a `You asked: "…"` banner
- **Install/Uninstall Claude Code Hook** commands — one-command setup that records a Git checkpoint at each request boundary
- Shows only the agent's edited files, hiding your own manual changes
- Changes that cancel out across requests still appear (e.g. add-then-remove shows the removal instead of nothing)
- Rejecting in timeline mode restores files to how they were before that request (creates are deleted); accepting marks reviewed as the baseline moves on
- Live refresh when a new interaction is recorded (watches `.git/acr/timeline.jsonl`)
- Working-tree mode (diff vs `HEAD`) is preserved as a fallback for other agents or before the hook records anything
- New Session now clears the recorded timeline and resets the checkpoint baseline
- `agentChangeReview.hookScope` setting (`project` | `global`) controls where the hook is installed

## 0.1.0

- Review sessions: "New Session" sets a baseline so later edits group under "This session" vs "Earlier changes"
- Ignore patterns via `agentChangeReview.ignore` (glob support for `*`, `**`, `?`)
- `agentChangeReview.autoOpen` opens the panel automatically on the first agent edit
- URI handler so external tools can open/refresh the panel (`vscode://<publisher>.agent-change-review/open`)
- Claude Code `PostToolUse` hook guide in the README

## 0.0.3

- Accept All and Reject All actions (header buttons + commands)
- Keyboard shortcuts when the panel is focused: Alt+A accept all, Alt+Shift+R reject all, Alt+R refresh
- In-panel hunk navigation: `j`/`k` (or arrows) to move, `a`/`r` to accept/reject the selected hunk, `Shift+A`/`Shift+R` for the whole file
- Auto-refresh now ignores `.git`, `node_modules`, `out`, `dist`, and test output

## 0.0.2

- Parse the diff into individual hunks and show each hunk separately
- Accept an individual hunk (mark it reviewed)
- Reject an individual hunk (reverse-apply just that hunk to the working tree)
- A file is marked reviewed only once all of its hunks are accepted
- Clear error when a hunk no longer applies because the file changed while reviewing
- Reviewed state is tracked per hunk and pruned automatically when the diff changes

## 0.0.1

- Initial release
- Detect the Git repository for the current workspace
- Show changed files from the Git working tree (staged, unstaged, and untracked)
- Display the unified diff for each changed file
- Accept a file (mark reviewed, keep content)
- Reject a file (revert to HEAD, or delete an untracked/new file)
- Manual refresh command and optional automatic refresh
