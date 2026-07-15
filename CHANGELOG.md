# Changelog

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
