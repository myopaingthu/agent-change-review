# Publishing

How to publish **Agent Change Review** to the VS Code Marketplace and Open VSX.

Publisher id: `myopaingthu` · Extension id: `myopaingthu.agent-change-review`

> Open VSX matters for this extension specifically: **Cursor, Windsurf, VSCodium, and Gitpod install from Open VSX, not the Microsoft Marketplace.** Since the audience is Claude Code / Cursor users, publish to both.

---

## One-time setup

### 1. Microsoft Marketplace publisher — done

The publisher `myopaingthu` exists at
<https://marketplace.visualstudio.com/manage/publishers/myopaingthu>, created with
a plain Microsoft account. No Azure subscription, credit card, or billing is
involved — the Marketplace is free for public extensions.

The publisher ID must stay identical to `publisher` in `package.json`, and it
cannot be renamed after creation.

### 2. Personal Access Token — only for `vsce publish`

Uploading through the web portal (route A below) needs no token at all. Get one
only if you want to publish from the terminal:

1. Sign in at <https://dev.azure.com> with the same Microsoft account. Creating an
   organization is free if you're prompted for one; it exists only to mint tokens.
2. User settings (top-right avatar) → **Personal access tokens** → **New Token**:
   - **Organization:** *All accessible organizations* — required; a single-org token fails with a 401 on publish.
   - **Scopes:** *Show all scopes* → **Marketplace** → **Manage**.
3. Create, then copy the token — it is shown once, and it expires (90 days by
   default, up to 1 year). A publish that suddenly 401s usually means it lapsed.
4. Store it in vsce so you don't have to paste it every time:
   ```bash
   npx @vscode/vsce login myopaingthu   # paste the PAT when prompted
   ```

### 3. Open VSX publisher + token

Open VSX has no web upload — the CLI is the only route, so this token is required.

1. Sign in at <https://open-vsx.org> with GitHub.
2. Settings → **sign the Eclipse Publisher Agreement** (one-time; publishing is rejected until you do).
3. Settings → **Access Tokens** → generate one; copy it.
4. Create the namespace (once):
   ```bash
   npx ovsx create-namespace myopaingthu -p <OPENVSX_TOKEN>
   ```

---

## Each release

### 1. Bump the version and changelog
- Update `version` in `package.json` (semver: patch = fixes, minor = features).
- Add a section to `CHANGELOG.md`.

**A published version number can never be reused**, even after unpublishing — a
bad upload costs you a version bump, so smoke-test first.

### 2. Package and smoke-test locally — do this before every publish
```bash
npm run compile
npx @vscode/vsce package          # -> agent-change-review-<version>.vsix
npx @vscode/vsce ls --tree        # optional: preview exactly what ships
```
Install the `.vsix` into a real editor and exercise it:
```bash
# the `code` CLI isn't on PATH by default on macOS
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension agent-change-review-<version>.vsix --force
```
(or Extensions view → `⋯` menu → **Install from VSIX…**), then open a repo, make a
Claude Code edit, confirm the panel shows it, and test accept/reject.

### 3. Publish

**Route A — web upload (no token).**
1. Go to <https://marketplace.visualstudio.com/manage/publishers/myopaingthu>.
2. **New extension → Visual Studio Code** (or `⋯` → **Update** on an existing one).
3. Drag the `.vsix` in. A verification scan runs; the listing is live in a few minutes.

**Route B — terminal.**
```bash
npx @vscode/vsce publish                 # uses the stored login, or add -p <PAT>
```

**Open VSX — always the CLI**, from the same `.vsix`:
```bash
npx ovsx publish agent-change-review-<version>.vsix -p <OPENVSX_TOKEN>
```

`vsce publish patch` (or `minor`/`major`) will bump `package.json` and create a git
tag for you instead of hand-editing the version — use it *or* step 1, not both.

### 4. Verify
- Marketplace: `https://marketplace.visualstudio.com/items?itemName=myopaingthu.agent-change-review` (live within a few minutes).
- Open VSX: `https://open-vsx.org/extension/myopaingthu/agent-change-review`.
- Install from a clean editor and confirm it activates.

---

## Notes
- **Push `master` first.** The Marketplace renders the packaged `README.md` as the
  listing page but rewrites relative links against the `repository` URL's *default
  branch*. Anything the README references must exist on `master`, not just on a
  feature branch, or it 404s on the listing.
- **`out/` is git-ignored but always shipped** — `vscode:prepublish` recompiles it into the `.vsix`, so a clean checkout still publishes correctly.
- **README = store page.** The first lines and any badges are the pitch; keep them current.
- The `.vsix` is git-ignored, so it won't be committed by accident.
- `.vscodeignore` keeps `TESTING.md`, `PUBLISHING.md`, the plan doc, `src/`, and
  `media/*.svg` out of the package — check `vsce ls --tree` after adding new
  top-level files.
