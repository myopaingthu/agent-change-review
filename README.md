# Agent Change Review

Review AI-generated code changes before keeping them. Works with Claude Code, Codex, Copilot, and any coding agent by using your Git working tree as the source of truth.

With the optional Claude Code hook, it becomes a **Cursor-style, per-request review**: each thing you ask the agent to do is reviewed on its own, showing only what the agent changed — not your manual edits.

## Two ways to review

**Per-interaction (timeline) mode** — recommended for Claude Code. After you run **Install Claude Code Hook** once, the panel shows exactly what the agent changed *in its latest request*, with a `You asked: "…"` banner. Each new request folds the previous one into the baseline, so:

- Your own hand-edits don't clutter the review — only the files the agent touched show up.
- Work that cancels out still shows. Ask the agent to *add* a comment, then to *remove* it: instead of showing nothing (the changes net to zero against your last commit), the panel shows the removal as the current step.

**Working-tree mode** — the fallback when no hook has recorded anything yet, or for agents other than Claude Code. Shows every change in your Git working tree versus the last commit (`HEAD`).

## Features

- Review only what the **agent** changed, one request at a time (timeline mode)
- See the unified diff for each file, split into individual hunks
- **Accept / Reject** a whole file or an individual hunk
- **Accept All / Reject All** in one click
- Keyboard-driven review (navigate hunks and accept/reject without the mouse)
- **Ignore patterns** to hide noise like lock files and build output
- Rejecting restores the file to how it was *before that request* (timeline mode) or to `HEAD` (working-tree mode); single hunks are reverse-applied
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

Without the hook, the panel still works in working-tree mode: it shows all changes versus your last commit.

## Commands

| Command | Description |
| --- | --- |
| `Agent Change Review: Open Review Panel` | Open the review panel |
| `Agent Change Review: Refresh Changes` | Reload the current changes |
| `Agent Change Review: Accept All Changes` | Mark every changed file as reviewed |
| `Agent Change Review: Reject All Changes` | Revert every change (tracked files to HEAD, delete new files) |
| `Agent Change Review: Start New Review Session` | Reset the baseline; clears the recorded timeline so your next request is reviewed fresh |
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
| `agentChangeReview.autoRefresh` | `true` | Refresh changed files automatically when workspace files change |
| `agentChangeReview.autoOpen` | `false` | Open the review panel automatically when an agent first edits files |
| `agentChangeReview.ignore` | `[]` | Glob patterns to hide from the review, e.g. `["**/package-lock.json", "**/*.lock", "dist/**"]` |
| `agentChangeReview.hookScope` | `project` | Where **Install Claude Code Hook** writes: `project` (`.claude/settings.local.json`) or `global` (`~/.claude/settings.json`) |

## Claude Code integration (per-interaction review)

Run **Agent Change Review: Install Claude Code Hook** once. Then restart your
Claude Code session so it picks up the hook. From then on, every request you make
is captured as its own review step.

### How it works

The hook records a lightweight Git checkpoint of your working tree at each
request boundary:

- **When you submit a prompt**, it snapshots the "before" state and remembers what you asked.
- **After each file edit**, it notes which file the agent touched.
- **When the agent finishes**, it snapshots the "after" state and records the interaction.

The panel then shows `after` vs `before`, limited to the files the agent edited —
so you review only the agent's work for that one request. Checkpoints are stored
as unreferenced Git objects under `refs/acr/head` and a log in
`.git/acr/timeline.jsonl`; they never touch your commits, index, or `git status`.

**New Session** clears this timeline and starts a fresh baseline.

### What the hook installs

It writes a small runner to `~/.claude/acr/hook.js` and adds three entries
(`UserPromptSubmit`, `PostToolUse` for `Edit|Write|MultiEdit|NotebookEdit`, and
`Stop`) to your Claude Code settings. Use **Uninstall Claude Code Hook** to remove
them. Node.js must be on your `PATH` for the hook to run.

## Limitations

- **Claude Code only** for per-interaction mode. Other agents fall back to working-tree mode.
- File **deletes/renames done via shell** (`rm`, `mv`) aren't captured as agent edits, since the hook watches `Edit`/`Write` tools. They still show in working-tree mode.
- In working-tree mode, untracked files are shown as full additions; hunk-level reject isn't supported for them — use **Reject file** to delete the file.
- Rejecting a file discards that file's changes for the request (timeline mode) or any uncommitted changes to it (working-tree mode).
- Hunk rejection can fail if the file changes while you are reviewing; refresh and try again.

## Disclaimer

This extension is not affiliated with Anthropic, Claude, OpenAI, Cursor, Google, or Microsoft.
