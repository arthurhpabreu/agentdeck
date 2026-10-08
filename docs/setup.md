# Setup

## Requirements

The primary development and validation platform is Windows 10/11 x64. The project also contains macOS-specific code, but the current release workflow produces Windows installers only. Linux desktop operation is not part of the validated platform set.

Install Git, Node.js 22.12+ with Corepack, Rust stable through rustup, Visual Studio Build Tools with **Desktop development with C++** and a Windows SDK, and Microsoft Edge WebView2 Runtime. Reopen the terminal after installation so `cargo` and Node are on PATH. The project pins pnpm 9.15.4.

For platform details, see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## Fresh checkout

The repository is public. Clone it and install the pinned dependencies:

```sh
git clone https://github.com/arthurhpabreu/agentdeck.git
cd agentdeck
corepack pnpm install --frozen-lockfile
corepack pnpm tauri dev
```

No `.env` file, personal path, API key, database dump or pre-existing workspace is required to build or open the app. RTK is optional. On a Node distribution without Corepack, install it first with `npm install --global corepack`.

For browser UI development, use `corepack pnpm dev` on port 1420. Native processes, file access and provider integration require the Tauri desktop runtime; browser tests replace these boundaries with fixtures.

## Coding agents

Install at least one supported official CLI and sign in through its interactive flow:

| Provider | CLI | Optional npm installation |
| --- | --- | --- |
| [OpenAI Codex](https://github.com/openai/codex#installation) | `codex` | `npm install --global @openai/codex` |
| [Claude Code](https://code.claude.com/docs/en/setup#install-with-npm) | `claude` | `npm install --global @anthropic-ai/claude-code` |
| [Google Gemini](https://geminicli.com/docs/get-started/installation/) | `gemini` | `npm install --global @google/gemini-cli` |

Native installations are also supported. Restart the app after changing PATH. Settings exposes detected CLI versions, native model catalogues and update actions. Capabilities depend on the installed provider and account.

Provider requirements can differ from the app's requirements. Check the linked installation guides for supported operating systems and runtime versions; Gemini CLI currently lists Windows 11 24H2 or newer.

Open a project, create a session and select a provider. Git projects can use independent session worktrees. Choose a Markdown folder or Obsidian vault under **Knowledge → Documents**; global and project sources are independent.

## Optional RTK integration

The token economy panel detects RTK and reports measurements separately from AI
usage. When enabled, Agent Deck supplies RTK guidance to Claude and Codex and
records commands executed through RTK in the app's measurement database. The
panel includes both providers; an available adapter is a capability, not proof
that a particular command used it.

For Codex, automatic command rewriting additionally requires **Execute** mode
with full access and native hook authorization through `/hooks`. Codex skips new
or modified hooks until they are trusted; see its [hook review documentation](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).
Direct `rtk` commands do not depend on hook authorization. Agent Deck leaves user
hook configuration in its original layer rather than copying it into session
arguments, which would execute inherited hooks twice.

## Isolated development

`corepack pnpm dev:worktree` selects free development/HMR ports and an isolated app identifier for the checkout. Optional shell overrides are `AGENTDECK_DEV_PORT`, `AGENTDECK_HMR_PORT`, `AGENTDECK_TAURI_PRODUCT_NAME` and `AGENTDECK_TAURI_IDENTIFIER`. Set these before launching; the wrapper does not load a `.env` file. Ordinary development uses port 1420. Windows hook receivers use loopback ports 46331 and 46332.

## Build installers

```powershell
powershell -NoProfile -File scripts/build-windows.ps1
```

The script builds frontend, native application and NSIS/MSI bundles under `src-tauri/target/release/bundle/`. Generated artifacts are ignored by Git. Local builds are unsigned; signing must be configured separately for signed distribution.

MSI generation also requires the Windows VBScript optional feature. See the [Tauri MSI prerequisites](https://v2.tauri.app/start/prerequisites/#vbscript-for-msi-installers) if packaging fails with a VBScript-related error.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `cargo` missing | Reopen the terminal; verify `%USERPROFILE%\.cargo\bin` is on PATH. |
| MSVC or SDK missing | Install the C++ workload and Windows SDK through Visual Studio Installer. |
| Corepack download fails | Check npm registry connectivity and retry the frozen install. |
| Development port occupied | Stop the other server or use `dev:worktree`. |
| CLI not detected | Check that it runs in a terminal, then restart Agent Deck. |
| Subagents unavailable | Use a provider-bound session with local native history; missing telemetry is explicitly labeled. |
| Vault reaches index limit | Choose a smaller source. Limits are 3,000 notes, 16 MiB of text and 1 MiB per note. |
| Codex RTK adapter is available but automatic rewriting does not run | Review the hook in native `/hooks`; automatic rewriting also requires Execute mode with full access. Direct RTK commands still work. |

The current app identifier stays `com.tuxao.agentdeck` to preserve existing Agent Deck data. Windows shared memory normally lives under `%APPDATA%\com.tuxao.agentdeck\shared-memory\memory.sqlite3`. Development state is isolated from production state. Personal settings and credentials do not travel with a checkout.

## Repository maintenance

The repository uses branch `main`. Maintainers with write access can commit reviewed changes and push to `origin/main`. Contributors should use a fork and pull request.

`scripts/publish-private.ps1` is retained as a utility for initial private publication. It checks the signed-in account, repository hygiene and private destination before pushing. It intentionally refuses an existing public destination and never changes repository visibility or force-pushes history. It is not needed to update this public repository.
