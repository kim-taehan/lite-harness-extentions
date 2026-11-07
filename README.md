# lite-harness-plugins

**English** · [한국어](README.ko.md)

**The distribution repository for Lite Harness — app installers and extensions in one place.**

This repository ships two things:

| What | Where |
|---|---|
| App installers (mac arm64 · mac x64 · win x64) | GitHub Releases tagged `app-v<version>` |
| Extensions | `catalog.json` + `dist/` (see [Layout](#layout)) |

Extensions for Lite Harness (the desktop app) are installed from here too. Turn on **Settings › Features › Plugin repository (beta)** in the app and it reads this repo's `catalog.json`, lists the extensions under [Browse plugins], installs one on click, and offers an update when a new version lands. Installing from a zip file (Settings › Features › Add plugin (zip)) still works as before.

## The problem

Extensions change far more often than the app. Bundle them into the app and every fix to a game or a language pack means rebuilding and redistributing the app. Stand up a separate extension marketplace server instead and it can't be reached from a closed network — and it's one more service to run. Hand zips around manually and nobody knows who runs which version or whether the file they got is the right one.

## The idea

Use a single git repository, not a server, as both the catalog and the distribution point.

1. **The catalog is one file** — `catalog.json` lists each extension's id, version, zip path, sha256 and changes. That's all the app needs to browse, install and update.
2. **Fetching is just git** — the app shallow-clones with the PC's own `git` and its credentials, so a company git server mirror or a folder carried in on USB works exactly the same as GitHub.
3. **Sources and outputs live together** — `npm run release` builds zips from `plugins/<id>/` and updates the catalog. Extensions that need a build step (bundling an MCP server, shipping a runtime) go out with the same single command.
4. **Trust the hash and the version** — a downloaded zip is installed only if it matches the catalog's sha256, and updates are offered only for higher versions. If permissions grow, the user is asked again.
5. **App installers in the same place** — users only need to know this one repository, for both the app and its extensions.

## Install & use

**Install the app** — download the installer from the `app-v<version>` [Releases](https://github.com/kim-taehan/lite-harness-plugins/releases) (macOS Apple Silicon / Intel, Windows). How to use the app is in [lite-harness-desktop](https://github.com/kim-taehan/lite-harness-desktop/blob/dev/README.md).

**Install extensions** — turn on **Settings › Features › Plugin repository (beta)** in the app and pick from [Browse plugins]. To install a single zip without the repository, add a zip from `dist/` via Settings › Features › Add plugin (zip).

### Using it in a closed network

If the company PC can't reach GitHub, carry the repository in.

1. Outside (on a PC with internet access), get this repository — GitHub's **Code › Download ZIP**, or `git clone https://github.com/kim-taehan/lite-harness-plugins.git`.
2. Move it to the company PC (USB, shared folder, …) and unpack it anywhere, e.g. `C:\lite-harness-plugins` or `~/lite-harness-plugins`.
3. In the app, expand **Settings › Features › Plugin repository** and set the repository address to that folder ([Choose folder]).
4. When a new version comes out, repeat steps 1–2 to overwrite the folder, then press [Check again] in the app.

If there is a company git server (GitLab etc.), you can mirror this repository there and use that address instead.

### How the app reads it

- The app uses the PC's own `git` and its credential setup to shallow-clone (`--depth 1`) the repository. It never pops up a login prompt (`GIT_TERMINAL_PROMPT=0`). Timeout is 15 seconds.
- The repository address doesn't have to be GitHub — it can be a **company git server** or a **folder path on this PC**. For a folder, the app reads that folder's `catalog.json` and `dist/` directly, without git (it doesn't even need to be a git repository).
- A downloaded zip is installed only if it matches the `sha256` in `catalog.json`; after that it goes through the same checks as a zip install (size · paths · manifest · app version · permission confirmation).
- If the repository can't be reached (closed network · offline · login required), the app keeps showing the last list it fetched and shows a notice on the browse screen only. Installed extensions keep running.

## Publishing extensions

### Layout

```
plugins/<id>/            Extension source — extension.json (plugin.json for plugins) + entry file (index.html · locale.json …). One folder per id, no category folders
plugins/<id>/build.mjs   Only for extensions that need a build — produces build/<id>[-<platform>].zip (see below)
dist/<id>-<version>.zip  Published zip (made by npm run release; only the latest version is kept)
categories.json          Extension id → category (game · dev-tool · locale), or unlisted to take it off the list. release writes it into the catalog's category
catalog.json             The list the app reads — id · name · description · category · details · permissions · type · size · version · zip · sha256 · changes (details · permissions · size are shown before install)
scripts/grammar-pack.mjs Packing shared by the grammar packs' build.mjs
scripts/release.mjs      Publish script (uses the system zip; runs build.mjs first if present)
package.json             Dependencies used by build.mjs (esbuild · MCP SDK · DB drivers · playwright-core) — pinned versions. Run npm ci before building
```

Shape of `catalog.json`:

```json
{
  "version": 1,
  "extensions": [
    { "id": "token-pet", "name": "빛톨 키우기", "description": "…", "version": "0.1.1",
      "zip": "dist/token-pet-0.1.1.zip", "sha256": "…", "changes": ["one line per change", "…"] }
  ]
}
```

### Releasing a new version

1. Edit the files in `plugins/<folder>/`.
2. Bump `version` in `extension.json` (`1.2.3` form). To show what changed in the update dialog, put a `changes.txt` in that folder with one change per line (optional — it isn't put in the zip, only into the catalog's `changes`. Don't put it in `extension.json`: the app rejects the install over an unknown field).
3. Publish and push.

```bash
npm run release <id or folder>   # one
npm run release -- --all         # all
git add -A && git commit -m "<id> 1.2.3" && git push
```

For a new extension, create a folder under `plugins/` and follow the same steps.

### Versioning rules

- Versions are three numbers, `major.minor.patch`. The app compares them numerically and offers an update **only when it's higher than the installed one**; it never downgrades.
- Never re-publish different content under the same version — PCs that already installed it won't notice. If you change something, bump the version.
- If an update adds permissions (`permissions`), the app asks the user again. If not, it updates without asking.

### Extensions that need a build

If a folder has a `build.mjs`, `npm run release <id>` runs it first and publishes the resulting `build/<id>[-<platform>].zip` as is. Run `npm ci` once first to install dependencies.

| Extension | What the build does | How to publish |
|---|---|---|
| `sql-tuning` | Bundles the MCP server together with its drivers (oracledb · pg) into one file | `npm run release sql-tuning` |
| `ui-test` | Bundles the MCP server and ships playwright-core next to it (the browser is the PC's Chrome · Edge) | `npm run release ui-test` |
| `chrome-browser` | Fetches Playwright MCP from the registry at a pinned version · sha512 and ships it | `npm run release chrome-browser` |
| `rust-grammar` · `csharp-grammar` · `kotlin-grammar` | Extracts the wasm from the grammar package (aliased as `code-grammar-*` in package.json) and packs it with extension.json · LICENSE (`scripts/grammar-pack.mjs`) | `npm run release rust-grammar` |
| `sonarqube` | Fetches the analyzer (Java runtime + SonarScanner, ~100 MB unpacked) per platform and ships it | `npm run release -- sonarqube --platform darwin-arm64` |

- To include a company SQL standard in sql-tuning, bundle with `node plugins/sql-tuning/build.mjs --standard <standard.md>` and then `npm run release -- --zip build/sql-tuning.zip`.
- sonarqube is platform-specific, so `--platform` (`darwin-arm64` · `darwin-x64` · `win32-x64`) is required, and `--all` skips it. The analyzer is fetched outside the closed network by `plugins/sonarqube/fetch-runtime.mjs`, pinned by version · sha256, into `build/vendor/` (not committed to git — several GB once fetched). Only the mac (Apple silicon) build is verified so far.
- To add a grammar pack: one folder (extension.json · LICENSE · the same one-line build.mjs as the other packs) + `npm i -D -E code-grammar-<language>@npm:<grammar package>@<version>` + one line in categories.json. The app rejects installing a pack for file extensions it already supports.
- Bumping chrome-browser's Playwright MCP version may rename tools — re-check `DENIED` in `server.mjs` against the new `tools/list`.
- Tests for extensions that need a build live in `plugins/<id>/tests/`. Run them with `npm test` (vitest); they aren't put in the zip (build.mjs ships only the files it picks).
- release checks the category of every target before building. If any is missing, it stops without touching dist or the catalog.

### `category` in catalog entries

Write one category per extension id in `categories.json`. The value is one of `game` · `dev-tool` · `locale`; if it's missing or anything else, release stops. Add the line here before publishing a new extension.
Don't put it in `extension.json` (the app rejects the install over an unknown field). Folders aren't split by category either — keep one `plugins/<id>/`.

**Taking an extension off the list without deleting its source** — write `unlisted` instead of a category (e.g. `"vi-pack": "unlisted"`). Every release run then removes its catalog entry and dist zips (platform zips too) and keeps `plugins/<id>/` as is; `--all` skips it, and naming it (`npm run release vi-pack`) only takes it off the list. To list it again, write a category back and release it. PCs that already installed it keep it — the app never removes an extension that disappeared from the catalog.

### `platform` in catalog entries

An entry without `platform` is shown on every PC. With one, it's shown only on PCs whose `<os>-<cpu>` (Node's `process.platform`-`process.arch`) matches. The same id may have one entry per platform.

## Related repositories

Lite Harness is three repositories that ship together:

```
 lite-harness-plugins (this repo) ──(installers · catalog.json + extension zips)──▶ lite-harness-desktop
                                                                                         │  OpenAI-compatible API
                                                                                         │  (API key or company SSO)
                                                                                         ▼
                                                                                 lite-harness-gateway ──▶ LLMs (vLLM · Ollama · cloud …)
```

| Repository | Role | Relationship to this repo |
|---|---|---|
| [lite-harness-desktop](https://github.com/kim-taehan/lite-harness-desktop) | The desktop app (Electron) and the Android app (`mobile/`) | The consumer of this repo: the app's **Plugin repository** feature shallow-clones it with the PC's own git (or reads a company git server / local folder) to list, install and update extensions. Zip install still works without it. App installers are published here as `app-v<version>` releases. |
| **lite-harness-plugins** (this repo) | Distribution repo: app installers (`app-v<version>` releases) and extensions (`catalog.json` + `dist/*.zip`) | — Extension sources moved here from `extensions/` in desktop #1282. |
| [lite-harness-gateway](https://github.com/kim-taehan/lite-harness-gateway) | LLM gateway — a [LiteLLM](https://github.com/BerriAI/litellm) fork for the closed-network stack (SSO via Keycloak, key/team budgets, usage limits) | No direct relationship. It is the app's **model provider**: add it in Settings → Models with an API key, or use **SSO login** to sign in with a company account and fetch the models that account may use. |

## Scope & philosophy

- **No server.** Catalog and distribution are one git repository — no service to run, and in a closed network you carry the folder in.
- **Decouple app builds from extension releases.** Fixing an extension never requires redistributing the app.
- **Reproducible from source.** `dist/` and `catalog.json` can always be regenerated with `npm run release` from the `plugins/` sources and pinned dependencies.
- **No silent changes.** A version is never re-published, and the user is asked again when permissions grow.
