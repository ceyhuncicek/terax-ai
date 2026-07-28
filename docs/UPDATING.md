# Updating this fork

This is a fork of [crynta/terax-ai](https://github.com/crynta/terax-ai) carrying a small
patch stack on top of upstream. Updating means rebasing that stack onto a newer upstream
release, not merging.

## Remotes

| Remote     | Repository            |
| ---------- | --------------------- |
| `origin`   | `ceyhuncicek/terax-ai` |
| `upstream` | `crynta/terax-ai`      |

If `upstream` is missing: `git remote add upstream https://github.com/crynta/terax-ai.git`

## Steps

```sh
git fetch upstream
git rebase upstream/main
```

Resolve conflicts, then verify:

```sh
pnpm install --frozen-lockfile
pnpm run check-types
pnpm run test
cd src-tauri && cargo test
```

Publish and rebuild:

```sh
git push --force-with-lease origin main
pnpm tauri build
```

Then replace `/Applications/Terax++.app` with the freshly built bundle.

### Usual conflict hotspots

- **`src-tauri/tauri.conf.json`** — upstream bumps `version`, we override `productName`,
  `identifier`, window `title`, and `createUpdaterArtifacts: false`. Keep upstream's
  version, keep our Terax++ values.
- **`src/modules/editor/GitDiffPane.tsx`** — our split-view integration sits inside code
  upstream also edits.
- **Settings sections** (`src/settings/sections/*`, `src/modules/settings/store.ts`) —
  our added settings entries collide with upstream additions in the same lists.

## Keep the stack at five commits

The patch stack is deliberately five logical commits (commit history, statusbar sync
indicator, split diff view, branding, docs). Fewer, well-scoped commits mean fewer
conflict stops on every rebase.

Do not append follow-up fix commits. Instead commit them as fixups and fold them in:

```sh
git commit --fixup <commit-of-the-feature>
git rebase -i --autosquash upstream/main
```
