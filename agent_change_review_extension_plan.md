# Agent Change Review VS Code Extension — Full Build & Publish Plan

## 0. Goal

Build and publish a VS Code extension that gives a Cursor / Antigravity-style review workflow for AI agent code changes.

The extension should work with Claude Code, Codex, Copilot, and any other coding agent by using Git changes as the source of truth.

Recommended public name:

```text
Agent Change Review
```

Recommended extension identifier:

```text
agent-change-review
```

Why not name it `Claude Change Review`?

Because the extension is not official Anthropic software and should work with any agent. A generic name is safer for Marketplace publishing and more useful for future users.

---

## 1. Final Product Idea

The extension will provide a review panel inside VS Code.

After an AI agent modifies files, the user can open the panel and review changes like this:

```text
Changed files
├── src/order.service.ts
│   ├── Hunk 1: accept / reject
│   └── Hunk 2: accept / reject
├── src/order.controller.ts
│   └── Hunk 1: accept / reject
└── package.json
    └── Hunk 1: accept / reject
```

Main actions:

```text
- Accept hunk
- Reject hunk
- Accept file
- Reject file
- Accept all
- Reject all
- Refresh changes
```

Important MVP decision:

```text
Do not try to modify Claude Code official extension first.
Build a separate VS Code extension that works using Git diff.
```

This makes the MVP realistic, independent, and easier to publish.

---

## 2. Technical Strategy

Use Git as the change source.

The extension does not need to know Claude Code internals.

Basic flow:

```text
AI agent edits files
↓
Extension runs git diff
↓
Extension parses changed files and hunks
↓
User reviews changes in VS Code panel
↓
Accept = keep the change
↓
Reject = reverse the file/hunk using Git
```

Recommended implementation stack:

```text
Language: TypeScript
Runtime: Node.js
Editor API: VS Code Extension API
Diff source: git diff
UI: VS Code Webview panel
State: VS Code workspaceState
Publishing: vsce
```

---

## 3. Required Tools

Install these first:

```bash
node -v
npm -v
git --version
code --version
```

You need:

```text
- Node.js
- npm
- Git
- Visual Studio Code
```

Install the VS Code extension publishing CLI:

```bash
npm install -g @vscode/vsce
```

VS Code’s official docs use Yeoman and `generator-code` to scaffold extensions, and `vsce` to package and publish extensions.

References:

- https://code.visualstudio.com/api/get-started/your-first-extension
- https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- https://code.visualstudio.com/api/references/extension-manifest

---

## 4. Create the Extension Project

Run:

```bash
npx --package yo --package generator-code -- yo code
```

Choose these options:

```text
? What type of extension do you want to create?
  New Extension (TypeScript)

? What's the name of your extension?
  Agent Change Review

? What's the identifier of your extension?
  agent-change-review

? What's the description?
  Review and accept/reject AI agent code changes by file or hunk.

? Initialize a git repository?
  Yes

? Which bundler to use?
  unbundled

? Which package manager to use?
  npm
```

Then enter the folder:

```bash
cd agent-change-review
code .
npm install
```

---

## 5. Recommended Project Structure

Use this structure:

```text
agent-change-review/
├── .github/
│   └── workflows/
│       └── test.yml
├── .vscode/
│   ├── launch.json
│   └── tasks.json
├── media/
│   └── icon.png
├── src/
│   ├── extension.ts
│   ├── git.ts
│   ├── diffParser.ts
│   ├── reviewPanel.ts
│   └── types.ts
├── out/
├── README.md
├── CHANGELOG.md
├── LICENSE
├── SUPPORT.md
├── package.json
├── tsconfig.json
└── .vscodeignore
```

Suggested responsibilities:

```text
src/extension.ts
- Extension activation
- Register commands
- Create review panel
- Register file watcher

src/git.ts
- Run git commands
- Detect repo root
- Get changed files
- Get file diff
- Restore file
- Apply reverse patch

src/diffParser.ts
- Parse unified git diff
- Extract files
- Extract hunks
- Generate hunk patch

src/reviewPanel.ts
- Create VS Code webview
- Render changed files and hunks
- Handle accept/reject button messages

src/types.ts
- Shared TypeScript types
```

---

## 6. Update `package.json`

Your extension must have a valid VS Code manifest in `package.json`.

Example:

```json
{
  "name": "agent-change-review",
  "displayName": "Agent Change Review",
  "description": "Review AI agent code changes with accept/reject actions by file or hunk.",
  "version": "0.0.1",
  "publisher": "your-publisher-id",
  "engines": {
    "vscode": "^1.90.0"
  },
  "categories": ["Other"],
  "keywords": [
    "ai",
    "agent",
    "claude",
    "codex",
    "copilot",
    "diff",
    "review",
    "git"
  ],
  "pricing": "Free",
  "activationEvents": [
    "onCommand:agentChangeReview.open",
    "onCommand:agentChangeReview.refresh"
  ],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "agentChangeReview.open",
        "title": "Agent Change Review: Open Review Panel"
      },
      {
        "command": "agentChangeReview.refresh",
        "title": "Agent Change Review: Refresh Changes"
      }
    ],
    "configuration": {
      "title": "Agent Change Review",
      "properties": {
        "agentChangeReview.autoRefresh": {
          "type": "boolean",
          "default": true,
          "description": "Automatically refresh changed files when workspace files change."
        }
      }
    }
  }
}
```

Important notes:

```text
- name must be lowercase and unique.
- publisher must match your Marketplace publisher ID.
- version should start with 0.0.1.
- icon should be PNG, not SVG.
- keep keywords under 30.
```

---

## 7. MVP Feature Scope

Build in small releases.

### Version 0.0.1

```text
- Open review panel
- Run git diff
- Show changed files
- Show file-level diff
- Accept file = mark reviewed
- Reject file = restore file from HEAD
- Refresh changes
```

### Version 0.0.2

```text
- Parse hunks
- Show hunks under each file
- Reject individual hunk
```

### Version 0.0.3

```text
- Accept hunk
- Accept all
- Reject all
- Keyboard shortcuts
```

### Version 0.1.0

```text
- Better UI
- Auto refresh
- Review session grouping
- Claude Code hook guide in README
```

### Version 0.2.0

```text
- Sidebar tree view
- Better untracked file support
- Conflict detection
- Safer patch handling
```

---

## 8. Core Git Commands

Use these Git commands internally.

Check if current workspace is a Git repo:

```bash
git rev-parse --show-toplevel
```

Get changed files:

```bash
git diff --name-only
```

Get full diff:

```bash
git diff --no-ext-diff --unified=3
```

Get diff for one file:

```bash
git diff --no-ext-diff --unified=3 -- path/to/file
```

Reject whole file:

```bash
git checkout -- path/to/file
```

Alternative for newer Git:

```bash
git restore path/to/file
```

Reject hunk:

```bash
git apply --reverse --whitespace=nowarn selected-hunk.patch
```

Accept file:

```text
Keep current file content and mark it as reviewed in extension state.
```

Optional accept and stage file:

```bash
git add path/to/file
```

---

## 9. Hunk Reject Strategy

For each hunk:

1. Parse file header from `git diff`.
2. Parse hunk header.
3. Build a temporary patch containing only that hunk.
4. Save it to a temporary file.
5. Run:

```bash
git apply --reverse --whitespace=nowarn /tmp/agent-change-review-hunk.patch
```

If this fails, show a clear error:

```text
Could not reject this hunk because the file changed while reviewing.
Please refresh and try again.
```

---

## 10. Important Edge Cases

Handle these clearly:

```text
- Workspace is not a Git repo
- No folder is open
- No changes found
- File is deleted
- File is renamed
- File is untracked
- File has merge conflicts
- User edits file while review panel is open
- git apply reverse patch fails
- Windows path issues
- File path contains spaces
```

For MVP, it is acceptable to show this limitation:

```text
Untracked files are shown but hunk-level reject is not supported yet.
```

---

## 11. Webview UI Plan

The review panel should show:

```text
Header:
Agent Change Review
[Refresh] [Accept All] [Reject All]

Changed files:
- src/order.service.ts
  [Accept File] [Reject File]
  Hunk 1
    [Accept Hunk] [Reject Hunk]
    diff block
  Hunk 2
    [Accept Hunk] [Reject Hunk]
    diff block

- package.json
  [Accept File] [Reject File]
  Hunk 1
    [Accept Hunk] [Reject Hunk]
    diff block
```

Recommended UI principles:

```text
- Simple first
- No complex styling in MVP
- Use VS Code theme colors
- Make buttons obvious
- Show errors inside the panel and as VS Code notifications
```

---

## 12. Keyboard Shortcuts

Add these later, not necessarily in the first MVP:

```json
{
  "contributes": {
    "keybindings": [
      {
        "command": "agentChangeReview.nextChange",
        "key": "alt+n",
        "when": "editorTextFocus"
      },
      {
        "command": "agentChangeReview.previousChange",
        "key": "alt+p",
        "when": "editorTextFocus"
      },
      {
        "command": "agentChangeReview.acceptSelected",
        "key": "alt+a",
        "when": "editorTextFocus"
      },
      {
        "command": "agentChangeReview.rejectSelected",
        "key": "alt+r",
        "when": "editorTextFocus"
      }
    ]
  }
}
```

---

## 13. Build Prompt for Claude Code / Codex

Use this prompt to generate the first implementation:

```text
I want to build a VS Code extension called “Agent Change Review”.

Goal:
Create a Cursor/Antigravity-style post-change review UI for files modified by Claude Code or any coding agent.

Requirements:
1. Detect changed files in the current Git workspace.
2. Show a dedicated webview panel called “Agent Change Review”.
3. Display all changed files from git diff.
4. For each file, show a unified diff with hunks.
5. Add actions:
   - Accept hunk
   - Reject hunk
   - Accept file
   - Reject file
   - Accept all
   - Reject all
   - Refresh changes
6. Accept means mark as reviewed and keep the current file content.
7. Reject file means restore that file to HEAD using Git.
8. Reject hunk means apply a reverse patch only for that hunk.
9. Use Node.js child_process to call Git commands.
10. Use TypeScript.
11. Use VS Code Extension API.
12. Do not depend on Claude Code internal APIs for the MVP.
13. The extension should work with any Git project.
14. Add clear error handling when:
   - project is not a Git repo
   - no workspace is open
   - file has merge conflicts
   - reverse patch fails
   - working tree changed while reviewing
15. Start simple and make the code maintainable.
16. Use git diff output as source of truth.
17. Parse hunks from unified diff.
18. Use a webview for the review UI.
19. Keep reviewed state in VS Code workspaceState.

Please generate the full extension implementation with:
- package.json
- tsconfig.json
- src/extension.ts
- src/git.ts
- src/diffParser.ts
- src/reviewPanel.ts
- src/types.ts
- README.md
- CHANGELOG.md
- SUPPORT.md
- .vscodeignore
- development/run instructions
```

---

## 14. Run Locally During Development

Compile:

```bash
npm run compile
```

Open the extension project in VS Code:

```bash
code .
```

Press:

```text
F5
```

This opens a new VS Code window called:

```text
Extension Development Host
```

Inside that new window:

1. Open any Git project.
2. Make some file changes.
3. Open Command Palette.
4. Run:

```text
Agent Change Review: Open Review Panel
```

Test these actions:

```text
- Refresh changes
- Accept file
- Reject file
- Accept hunk
- Reject hunk
- Accept all
- Reject all
```

---

## 15. Test With Claude Code

1. Open a real project in VS Code.
2. Ask Claude Code to modify some files.
3. After Claude finishes, run:

```text
Agent Change Review: Open Review Panel
```

Expected result:

```text
The extension shows all modified files from git diff.
You can accept or reject changes from the review panel.
```

At MVP stage, this is enough.

The extension does not need Claude Code internal APIs.

---

## 16. Optional Claude Code Hook Integration Later

Later, you can add a guide for Claude Code hooks.

Possible idea:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "code --command agentChangeReview.refresh"
          }
        ]
      }
    ]
  }
}
```

But keep this for later.

For MVP, file watching and manual refresh are enough.

---

## 17. Add Marketplace Files

Before publishing, prepare these files:

```text
README.md
CHANGELOG.md
LICENSE
SUPPORT.md
media/icon.png
.vscodeignore
```

### README.md checklist

Include:

```text
# Agent Change Review

Review AI-generated code changes before keeping them.

## Features
- View changed files from Git diff
- Accept/reject whole file
- Accept/reject individual hunks
- Works with Claude Code, Codex, Copilot, and other coding agents
- Does not require Claude Code internal APIs

## Requirements
- Git project
- VS Code

## Usage
1. Let your AI coding agent modify files.
2. Open Command Palette.
3. Run "Agent Change Review: Open Review Panel".
4. Review changed files.
5. Accept or reject changes.

## Limitations
- First version works from Git diff.
- Untracked files may need special handling.
- Hunk rejection can fail if the file changes while reviewing.

## Disclaimer
This extension is not affiliated with Anthropic, Claude, OpenAI, Cursor, Google, or Microsoft.
```

### CHANGELOG.md example

```md
# Changelog

## 0.0.1

- Initial release
- Added Git diff review panel
- Added file-level accept/reject
- Added refresh command
```

### SUPPORT.md example

```md
# Support

Please open an issue in the GitHub repository if you find a bug or want to request a feature.

Include:

- VS Code version
- Extension version
- Operating system
- Steps to reproduce
- Error message or screenshot
```

### LICENSE

Recommended license:

```text
MIT
```

---

## 18. `.vscodeignore` Example

Create `.vscodeignore`:

```gitignore
.vscode/**
src/**
.gitignore
tsconfig.json
.vscode-test/**
out/test/**
node_modules/**/*.map
**/*.ts
*.vsix
```

This keeps unnecessary source/development files out of the published `.vsix` package.

---

## 19. Extension Icon

Create a PNG icon:

```text
media/icon.png
```

Recommended:

```text
Size: 128x128 or larger
Format: PNG
Avoid: SVG
```

Add this to `package.json`:

```json
"icon": "media/icon.png"
```

---

## 20. Package Locally

Run:

```bash
vsce package
```

This creates:

```text
agent-change-review-0.0.1.vsix
```

Install locally:

```bash
code --install-extension agent-change-review-0.0.1.vsix
```

Restart VS Code and test it as a normal installed extension.

---

## 21. Create Visual Studio Marketplace Publisher

You need a Marketplace publisher account.

Steps:

1. Open Visual Studio Marketplace publisher management.
2. Log in with your Microsoft account.
3. Create a publisher.
4. Choose a publisher ID carefully.

Example:

```text
Publisher Name: Myo Paing Thu
Publisher ID: myopaingthu
```

Then update `package.json`:

```json
"publisher": "myopaingthu"
```

Final extension ID will be:

```text
myopaingthu.agent-change-review
```

Important:

```text
The publisher ID is used in Marketplace URLs and should be chosen carefully.
```

---

## 22. Create Azure DevOps Personal Access Token

For manual publishing with `vsce`, create an Azure DevOps PAT.

Required settings:

```text
Organization: All accessible organizations
Scopes: Custom defined
Marketplace: Manage
```

Then login from terminal:

```bash
vsce login myopaingthu
```

Paste your PAT.

Expected success message:

```text
The Personal Access Token verification succeeded for the publisher 'myopaingthu'.
```

Security note:

```text
Do not commit the PAT.
Do not put the PAT inside package.json.
Do not share the PAT in README or GitHub issues.
```

---

## 23. Publish First Version

From the extension root:

```bash
npm run compile
vsce package
vsce publish
```

Or simply:

```bash
vsce publish
```

After publishing, your extension should appear in the VS Code Marketplace.

Users can install it from VS Code by searching:

```text
Agent Change Review
```

---

## 24. Publish Updates Later

Patch release:

```bash
vsce publish patch
```

Minor release:

```bash
vsce publish minor
```

Major release:

```bash
vsce publish major
```

Specific version:

```bash
vsce publish 0.1.0
```

Recommended release order:

```text
0.0.1 - file-level review
0.0.2 - hunk-level reject
0.0.3 - accept/reject all + keyboard shortcuts
0.1.0 - better UI + auto refresh
0.2.0 - sidebar + review sessions
```

---

## 25. GitHub Repository Setup

Create a GitHub repo:

```text
agent-change-review
```

Recommended repo description:

```text
VS Code extension to review AI agent code changes with accept/reject actions by file or hunk.
```

Push code:

```bash
git init
git add .
git commit -m "Initial Agent Change Review extension"
git branch -M main
git remote add origin git@github.com:YOUR_USERNAME/agent-change-review.git
git push -u origin main
```

---

## 26. Optional GitHub Actions Test Workflow

Create:

```text
.github/workflows/test.yml
```

Example:

```yaml
name: Test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Compile
        run: npm run compile

      - name: Package
        run: npx vsce package
```

Do manual publishing first.

Add automated publishing only after the extension is stable.

---

## 27. Common Publishing Errors

### Missing publisher

Error cause:

```text
package.json does not have publisher field.
```

Fix:

```json
"publisher": "myopaingthu"
```

### Wrong PAT scope

Error:

```text
401 Unauthorized
403 Forbidden
```

Fix:

```text
Organization: All accessible organizations
Scope: Marketplace Manage
```

### SVG icon issue

Fix:

```text
Use PNG for icon.
```

Example:

```json
"icon": "media/icon.png"
```

### Too many keywords

Fix:

```text
Keep Marketplace keywords under 30.
```

### Extension name already exists

Fix:

```text
Change package.json name.
```

Example:

```json
"name": "agent-change-reviewer"
```

---

## 28. First Public Release Checklist

Before running `vsce publish`, check:

```text
[ ] Extension compiles successfully
[ ] Extension works in Extension Development Host
[ ] Extension works after local VSIX install
[ ] README is clear
[ ] CHANGELOG exists
[ ] LICENSE exists
[ ] SUPPORT.md exists
[ ] icon.png exists
[ ] package.json has correct publisher
[ ] package.json has correct repository URL
[ ] package.json has correct version
[ ] Marketplace name is not misleading
[ ] Disclaimer says it is not official Claude/Anthropic extension
[ ] No secrets committed
[ ] No PAT in repository
[ ] .vscodeignore excludes unnecessary files
```

---

## 29. Practical Command Summary

```bash
# Create extension project
npx --package yo --package generator-code -- yo code

# Enter project
cd agent-change-review

# Install dependencies
npm install

# Open in VS Code
code .

# Compile
npm run compile

# Run locally
# Press F5 in VS Code

# Install vsce
npm install -g @vscode/vsce

# Package VSIX
vsce package

# Test VSIX locally
code --install-extension agent-change-review-0.0.1.vsix

# Login to publisher
vsce login myopaingthu

# Publish
vsce publish

# Publish future patch update
vsce publish patch
```

---

## 30. Recommended Development Roadmap

### Phase 1: Working MVP

```text
Goal: usable locally

- Git repo detection
- Changed file list
- File diff display
- Accept file
- Reject file
- Refresh
```

### Phase 2: Hunk Review

```text
Goal: Cursor-like review

- Parse hunks
- Accept hunk
- Reject hunk
- Better patch failure handling
```

### Phase 3: Better UX

```text
Goal: smoother review

- Accept all
- Reject all
- Keyboard shortcuts
- Auto refresh
- Review state
```

### Phase 4: Agent-Friendly Features

```text
Goal: better Claude Code / Codex workflow

- Claude Code hook guide
- Auto open panel after file changes
- Session grouping
- Ignore files/patterns
```

### Phase 5: Public Polish

```text
Goal: marketplace-ready extension

- Good README screenshots
- Demo GIF
- Clear limitation section
- GitHub issues template
- Marketplace tags
```

---

## 31. Final Recommendation

Build this as a separate extension first.

Do not wait for Claude Code official extension support.

Best first public version:

```text
Agent Change Review v0.0.1
- Works with any Git project
- Shows AI agent changes using Git diff
- Allows file-level accept/reject
```

After the extension works well, you can:

```text
1. Publish it to Marketplace.
2. Share it with other Claude Code users.
3. Create a GitHub issue/PR proposal to Claude Code with your extension as proof of concept.
```

This gives you the fastest realistic path from idea to usable product.
