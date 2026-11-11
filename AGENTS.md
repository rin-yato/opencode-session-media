# AGENTS.md

## What this is

A GUI-only OpenCode Desktop plugin with no server part. It adds a **Media** panel to a session's side region.

- **GUI window** (`src/gui.tsx`, `src/panel.tsx`, `src/lightbox.tsx`): panel, menu item, command, viewer.
- **GUI main** (`src/main.ts`, `src/contract.ts`): Electron main-process Ipc `opencode-session-media.files` with `read`, `measure`, `stage`.
- **Data** (`src/store.ts`, `src/extract.ts`, `src/source.ts`): per-session media store, message-to-item extraction, image source loader.
- **Layout** (`src/grid.ts`, `src/size.ts`, `src/fit.ts`): grouped uniform grid (pure `layoutGrid`, `groupItems`), header size parser, viewer fit.

## Commands

```sh
bun install
bun run check     # typecheck + unit tests
bun run build     # dist/gui-experimental.cjs
bun run dev       # watch mode; each rebuild hot-reloads the plugin
bun run changeset # add a release changeset
bun run format
```

`dist/` is not committed. Run `bun run build` after changes.

## Releases

Same flow as `opencode-simulator`. Every push to `main` runs `.github/workflows/release.yml`, which consumes pending changesets (or makes a patch one), bumps the version, commits `chore(release): vX.Y.Z`, and publishes to npm with trusted publishing (OIDC, no token). The trusted publisher on npmjs.com names this repo and `release.yml`; renaming the workflow breaks publishing. Test versioning in a throwaway clone with `DRY_RUN=true bash scripts/release.sh`. The release commits to `main`, so keep it unprotected.

## Rules

- Tiles are keyed by item and positioned absolutely. A resize may only rewrite positions. Never read the width inside anything that remounts tiles.
- Cells are uniform 4:3 landscape boxes, so layout never waits on image sizes. Path-only items (no bytes) wait for an exists check (`measure`); an unknown `exists` means hidden. Items with bytes always show.
- Turns: a user prompt plus later messages until the next prompt (no parent link in the API); the store assigns `turn` in `add`.
- Items dedupe by file path in `merge`; the copy that has bytes wins.
- Main reads only absolute-path png/jpg/gif/webp files up to 20 MB.
- Icon names must come from the host's `IconName` list (`photo`, not `image`).
- i18n placeholders use `{{count}}`, double braces.
- `effect` is pinned to the version `@opencode/plugin` expects.
- The viewer root sets `pointer-events: auto`; the host dialog layer disables it.
- No telemetry or outbound requests.

## Verify

- `bun run check`
- `bun run build`
- Visual changes need a check in the desktop app: resize the panel, open the viewer, step with the arrow keys.
