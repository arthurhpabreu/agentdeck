# Setup

## Requirements

The primary development and validation platform is Windows 10/11 x64. The project also contains macOS-specific code, but the current release workflow produces Windows installers only. Linux desktop operation is not part of the validated platform set.

Install Git, Node.js 22.12+ with Corepack, Rust stable through rustup, Visual Studio Build Tools with **Desktop development with C++** and a Windows SDK, and Microsoft Edge WebView2 Runtime. Reopen the terminal after installation so `cargo` and Node are on PATH. The project pins pnpm 9.15.4.

For platform details, see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## Fresh checkout

The repository is private. Authenticate Git with an account that has access, then run:

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
| Vault reaches index limit | Choose a smaller source. Limits are 3,000 notes, 16 MB of text and 256 KB per note. |

The current app identifier stays `com.tuxao.agentdeck` to preserve existing Agent Deck data. Windows shared memory normally lives under `%APPDATA%\com.tuxao.agentdeck\shared-memory\memory.sqlite3`. Development state is isolated from production state. Personal settings and credentials do not travel with a checkout.

## Initial private publication

The prepared checkout uses branch `main`. Authenticate GitHub CLI as `arthurhpabreu`, commit the reviewed files and run `powershell -NoProfile -File scripts/publish-private.ps1`. The script checks the signed-in account, repository hygiene and destination visibility, creates the private repository if missing, then pushes `main`. It never changes an existing repository's visibility or force-pushes history.
