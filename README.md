# Agent Change Review

Review what a coding agent changed, one request at a time, before keeping it. A Claude Code hook records a Git checkpoint around each request, so the panel shows the agent's work for that request — and only the agent's.

## What it shows

**Only the agent's latest request — nothing else.** After you run **Install Claude Code Hook** once, the panel shows exactly what the agent changed in its most recent request. It is *not* a list of your uncommitted changes:

- **Your own hand-edits never appear.** Only files the agent actually edited are shown.
- **Work that cancels out still shows.** Ask the agent to *add* a comment, then to *remove* it: the net diff against your last commit is zero, but the panel shows the removal as the current step, because the previous request has been folded into the baseline.
- **Anything you commit, stage, or edit yourself is irrelevant** to what's displayed.

## Multi-repo workspaces

A workspace can hold several repos — a folder containing `backend/` and `frontend/`, or a multi-root workspace. Both are supported, including a **single request that edits several repos at once**: the panel merges them into one review, grouped by repo name.

The repo for each change is derived from the edited **file's path**, so it doesn't matter where Claude Code is running from — the workspace root doesn't even need to be a repo itself. Repo discovery reuses VS Code's own detection (the same repos you see in Source Control), plus a shallow filesystem scan as a backup.

## Features

- Review only what the **agent** changed, one request at a time — never your own edits
- Handles a request that spans **several repos** at once, grouped by repo
- See the unified diff for each file, split into one hunk per contiguous run of changed lines — so unrelated edits are reviewed independently rather than as a block
- **Accept / Reject** a whole file or an individual hunk
- **Accept All / Reject All** in one click
- Keyboard-driven review (navigate hunks and accept/reject without the mouse)
- **Ignore patterns** to hide noise like lock files and build output
- Rejecting undoes the agent's change and **keeps any edits you made to that file yourself**
- Refresh on demand, auto-refresh as the agent edits, or auto-open the panel on the first change
- No dependency on any agent's internal APIs — it only reads Git and a Claude Code hook

## Requirements

- A Git repository — the extension uses Git to snapshot, diff, and revert changes. If the folder isn't a repo yet, the panel offers a one-click **Initialize Git Repository**.
- VS Code 1.90 or newer

## Usage

1. (Claude Code, recommended) Run **Agent Change Review: Install Claude Code Hook** once, then restart your Claude Code session.
2. Run **Agent Change Review: Open Review Panel** and keep it open.
3. Let your agent work. After each request, the panel shows exactly what it changed.
4. Review each file/hunk and click **Accept** or **Reject**.

The hook is required — without it nothing is recorded and the panel has nothing to show. It is the only thing that knows which changes came from the agent.

## Commands

| Command | Description |
| --- | --- |
| `Agent Change Review: Open Review Panel` | Open the review panel |
| `Agent Change Review: Refresh Changes` | Reload the current changes |
| `Agent Change Review: Accept All Changes` | Mark every changed file as reviewed |
| `Agent Change Review: Reject All Changes` | Undo the agent's changes in every file from this request |
| `Agent Change Review: Reset Review Baseline` | Clear recorded history so your next request is reviewed fresh |
| `Agent Change Review: Install Claude Code Hook` | Set up the hook so each agent request appears in the panel |
| `Agent Change Review: Uninstall Claude Code Hook` | Remove the hook configuration |

## Keyboard shortcuts

When the review panel is focused:

| Key | Action |
| --- | --- |
| `Alt+A` | Accept all |
| `Alt+Shift+R` | Reject all |
| `Alt+R` | Refresh |
| `j` / `↓`, `k` / `↑` | Select next / previous hunk |
| `a` / `r` | Accept / reject the selected hunk |
| `Shift+A` / `Shift+R` | Accept / reject the selected hunk's whole file |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `agentChangeReview.autoRefresh` | `true` | Re-render the review automatically as files change |
| `agentChangeReview.autoOpen` | `false` | Open the review panel automatically when the agent records a new request |
| `agentChangeReview.ignore` | `[]` | Glob patterns to hide from the review, e.g. `["**/package-lock.json", "**/*.lock", "dist/**"]` |
| `agentChangeReview.hookScope` | `project` | Where **Install Claude Code Hook** writes: `project` (`.claude/settings.local.json`) or `global` (`~/.claude/settings.json`) |

## Claude Code integration (per-interaction review)

Run **Agent Change Review: Install Claude Code Hook** once. Then restart your
Claude Code session so it picks up the hook. From then on, every request you make
is captured as its own review step.

### How it works

The hook records lightweight Git checkpoints as the agent works:

- **When you submit a prompt**, it starts an interaction.
- **Just before the agent's first edit to a repo**, it snapshots that repo — the "before" baseline.
- **After each edit**, it notes which file (and which repo) the agent touched.
- **When the agent finishes**, it snapshots each touched repo and records the request.

The panel then diffs each repo's **baseline against the agent's result**, limited
to the files the agent edited. Both ends are fixed checkpoints, so the diff is
the agent's own work and nothing else — editing one of those files yourself never
adds your edits to the review. Your working tree is consulted only to drop files
you've already dealt with.

Because the repo is derived from each edited file's path, a request can span
several repos and Claude Code can run from anywhere. Checkpoints are stored as
Git objects kept alive by `refs/acr/head`, with a log in `.git/acr/timeline.jsonl`
— they never touch your commits, index, or `git status`.

**New Session** clears these timelines and starts a fresh baseline.

### What the hook installs

It writes a small runner to `~/.claude/acr/hook.js` and adds four entries
(`UserPromptSubmit`, `PreToolUse` and `PostToolUse` for
`Edit|Write|MultiEdit|NotebookEdit`, and `Stop`) to your Claude Code settings. Use
**Uninstall Claude Code Hook** to remove them. Node.js must be on your `PATH` for
the hook to run.

## Limitations

- **Claude Code only.** The hook is what identifies agent changes; other agents record nothing, so the panel stays empty.
- **One request at a time.** Only the latest request is shown; earlier ones are treated as accepted. Two Claude sessions running at once will show whichever finished last.
- File **deletes/renames done via shell** (`rm`, `mv`) aren't captured, since the hook watches the `Edit`/`Write` tools.
- Files matching `.gitignore` aren't tracked (checkpoints use `git add -A`).
- If you edit the **same lines** the agent did, its change can no longer be undone on its own. Rejecting the file then offers a full restore (which discards your edits to it); rejecting a single hunk just reports the conflict.
- A file you edit **while the agent is still working** on that same file can't be told apart from the agent's own work, so it will appear in the review.

## Disclaimer

This extension is not affiliated with Anthropic, Claude, OpenAI, Cursor, Google, or Microsoft.
