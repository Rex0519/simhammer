# Rex0519/simhammer — fork notes

The app is branded **Magic World Sim** (product name, window title, UI strings, installer
names `MagicWorldSim-*`). Package name, `appId` (`com.simhammer.app`) and the user-data
directory (`simhammer-desktop`) are unchanged so data and the update channel carry over.

This fork of [sortbek/simcraft](https://github.com/sortbek/simcraft) carries
Raidbots-parity features (zh_CN locale, Top Gear lock-slot / socket budget /
upgrade budget, Drop Finder source priority summary, Talent Compare) and its
own auto-update channel.

## Branches

| Branch | Purpose |
| --- | --- |
| `main` | Default. Upstream + all features + fork-only commits (updater, CI). Every push builds and releases. |
| `master` | Read-only mirror of upstream `master`, refreshed weekly by `sync-upstream.yml`. |
| `sh/feat/260907-wuqi-*` | One branch per feature, cut from upstream `415c6a7`, for upstream pull requests. |

## Releasing

The `VERSION` file is the single source of truth. Scheme: `<upstream version>-rex.<build>`.

```bash
V=4.3.3-rex.3
printf '%s\n' "$V" > VERSION
sed -i '' "s/^version = \".*\"/version = \"$V\"/" backend/Cargo.toml
(cd backend && cargo update --workspace --offline)
for d in frontend desktop .; do (cd $d && npm version "$V" --no-git-tag-version --allow-same-version); done
git commit -am "chore(release): $V" && git push github main
```

`Desktop Release` builds macOS (arm64 DMG), Windows (NSIS) and Linux
(AppImage, deb) and creates or refreshes the GitHub Release `v<VERSION>`
together with the `latest*.yml` manifests electron-updater reads. Pushing
`main` again with the same `VERSION` rebuilds and replaces the assets.

## Auto-update behaviour

`desktop/package.json` → `build.publish` points at this repository, so
installed apps check these releases (5 s after launch and on demand).

- Windows / Linux: in-place download and restart (electron-updater).
- macOS: the app is **unsigned** (no Apple Developer ID), and Squirrel.Mac
  refuses to install unsigned updates. The update panel therefore offers
  "Download DMG", which opens the release asset in the browser; drag the new
  app over the old one. To restore silent in-place updates, add the five
  signing secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) to the repository — the
  workflows already use them when present.

## Upstream sync

`sync-upstream.yml` (Mondays 03:17 UTC, or *Run workflow*) fast-forwards
`master` to upstream and opens a pull request `master → main`. Merge it by
hand; the three Top Gear features touch shared generator signatures, so
conflicts there are expected after upstream refactors.

## Local development notes

- Toolchain: `backend/rust-toolchain.toml` pins Rust 1.96 (rustup). On
  macOS 27 the release-profile `sqlx_macros` proc-macro dylib is rejected by
  dyld ("mis-aligned LINKEDIT string pool"); CI runners are unaffected. For a
  local DMG, build the backend in the dev profile.
- Game data: `backend/resources/data/fetch-data.sh` does not work with BSD
  sed; fetch the files listed in Raidbots `metadata.json` with node/python,
  then `node backend/scripts/compact-data.js backend/resources/data backend/resources/data-compacted`
  (the test suite needs the compacted directory).
