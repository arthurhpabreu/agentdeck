# Setup

## Requirements

Agent Deck supports Windows 10/11 x64 and macOS 11+ on Apple Silicon and Intel with Safari/WebKit 16.4 or newer. Install the available macOS and Safari updates before running the app; its WebView uses the system WebKit. Both platforms share the same source, app identity and version. macOS downloads use a universal binary. Linux desktop operation is outside the validated platform set.

The WebKit minimum follows the [Tailwind 4 browser baseline](https://tailwindcss.com/docs/compatibility). [Apple provides Safari 16.4 for Big Sur, Monterey and Ventura](https://developer.apple.com/documentation/safari-release-notes/safari-16_4-release-notes), so the native deployment target can remain macOS 11.0. Native CI and packaged startup are exercised on macOS 15; the minimum system version is verified in bundle metadata and both executable architectures.

Install Git, Node.js 22.12+ with Corepack and Rust stable through rustup. The project pins pnpm 9.15.4. On Windows, also install Visual Studio Build Tools with **Desktop development with C++**, a Windows SDK and Microsoft Edge WebView2 Runtime. On macOS, install Xcode Command Line Tools with `xcode-select --install`. Reopen the terminal after installation so `cargo` and Node are on PATH.

For platform details, see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## Install on macOS

1. Download `Agentdeck_<version>_universal.dmg` from the [official release](https://github.com/arthurhpabreu/agentdeck/releases). The same file works on Apple Silicon and Intel.
2. Open the DMG and drag **Agentdeck** into **Applications**. Eject the disk image and launch the installed copy.
3. The current package is ad-hoc signed, without Apple Developer ID notarization. If Gatekeeper blocks the first launch, follow [Apple's app approval instructions](https://support.apple.com/en-us/102445): after attempting to open it, use **System Settings → Privacy & Security → Open Anyway** for this app. On older macOS versions, the equivalent panel is in System Preferences.

The `_universal.app.tar.gz` asset contains the same application bundle as an alternative for manual extraction. Settings downloads and verifies the DMG before opening it; quit Agent Deck before replacing the installed app. Preferences and local history stay in the user's application support folder. A managed Mac may restrict approving unnotarized apps.

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

Native installations are also supported. Restart the app after changing PATH. On macOS, the desktop initializes common Homebrew and user CLI locations and supplies the resolved executable/Node paths to child processes. It does not execute shell startup scripts to discover tools. Terminals use the native default login shell, and shortcuts use Command while terminal Ctrl+C still interrupts the process. Settings exposes detected CLI versions, native model catalogues and update actions. Capabilities depend on the installed provider and account.

Claude Code normally keeps its macOS credentials in Keychain. Agent Deck leaves authentication there and can show usage reported by the provider/statusline; a missing credentials file does not imply that the user signed out.

Provider requirements can differ from the app's requirements. Check the linked installation guides for supported operating systems and runtime versions; Gemini CLI currently lists Windows 11 24H2 or newer.

Open a project, create a session and select a provider. Git projects can use independent session worktrees. Choose a Markdown folder or Obsidian vault under **Knowledge → Documents**; global and project sources are independent.

## Telegram notifications

Agent Deck can also send a short notification to your private Telegram chat when an agent finishes a response and awaits your next instruction. Telegram has official apps for both [Android and iPhone/iPad](https://telegram.org/apps). This optional integration starts disabled and sends no task progress, prompts, response content or project paths.

1. In Telegram, open the official [@BotFather](https://t.me/BotFather), send `/newbot` and follow its instructions to create a bot specifically for Agent Deck. Copy the bot token it provides. See Telegram's [bot setup guide](https://core.telegram.org/bots/tutorial#obtain-your-bot-token).
2. In Agent Deck, open **Settings → System → Notifications → Telegram notifications**. Paste the token into **Bot token** and click **Connect Telegram**.
3. Click **Open bot in Telegram** and press **Start** in the private conversation. The link includes a pairing code that expires in 10 minutes so Agent Deck can identify the conversation you authorized.
4. Return to Agent Deck and click **I started the conversation** to confirm the connection.
5. Turn on **Also notify me on Telegram** and keep the main **Notifications** toggle on for automatic completion alerts. Click **Send test** to check delivery on your phone. Tests are sent only when you click this button, including when automatic alerts are disabled.

Allow Telegram notifications in Android or iOS settings and make sure the bot conversation is not muted. The computer must remain awake, with Agent Deck running and internet access; messages go directly from the desktop app to Telegram, without an Agent Deck server. The native completion detector filters duplicate and progress events before forwarding an alert.

The token is hidden in the setup field and stored in the operating system's credential store after successful pairing, outside browser preferences and the repository. Keep it private: Telegram identifies it as the credential controlling your bot. **Disconnect** removes the saved connection and token from this computer. If you revoke a token in BotFather, reconnect with the replacement token.

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

Build on the operating system being packaged:

```sh
corepack pnpm build:windows   # Windows x64: NSIS + MSI
corepack pnpm build:macos     # macOS: universal app + DMG
```

Windows artifacts go under `src-tauri/target/release/bundle/`; macOS artifacts go under `src-tauri/target/universal-apple-darwin/release/bundle/`. The Mac script installs both Rust targets and sets the minimum deployment target to macOS 11.0. Generated artifacts are ignored by Git. `scripts/build-windows.ps1` remains a compatibility wrapper.

Windows builds are unsigned; macOS uses ad-hoc signing by default. For Developer ID signing and notarization, maintainers configure all six repository secrets together: `APPLE_CERTIFICATE` (base64 PKCS#12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific password) and `APPLE_TEAM_ID`. The workflow imports the certificate into a temporary keychain, verifies the signature and notarization, then removes the keychain. See [Tauri's signing guide](https://v2.tauri.app/distribute/sign/macos/).

MSI generation also requires the Windows VBScript optional feature. See the [Tauri MSI prerequisites](https://v2.tauri.app/start/prerequisites/#vbscript-for-msi-installers) if packaging fails with a VBScript-related error.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `cargo` missing | Reopen the terminal; verify `%USERPROFILE%\.cargo\bin` (Windows) or `~/.cargo/bin` (macOS) is on PATH. |
| MSVC or SDK missing | Install the C++ workload and Windows SDK through Visual Studio Installer. |
| Corepack download fails | Check npm registry connectivity and retry the frozen install. |
| Development port occupied | Stop the other server or use `dev:worktree`. |
| CLI not detected | Check that it runs in a terminal, then restart Agent Deck. |
| macOS blocks first launch | Follow the per-app approval procedure above; the current release is not notarized. |
| macOS build tools missing | Run `xcode-select --install` and complete the Apple tool installation. |
| Subagents unavailable | Use a provider-bound session with local native history; missing telemetry is explicitly labeled. |
| Vault reaches index limit | Choose a smaller source. Limits are 3,000 notes, 16 MiB of text and 1 MiB per note. |
| Codex RTK adapter is available but automatic rewriting does not run | Review the hook in native `/hooks`; automatic rewriting also requires Execute mode with full access. Direct RTK commands still work. |

The app identifier stays `com.tuxao.agentdeck` to preserve existing Agent Deck data. Shared memory normally lives under `%APPDATA%\com.tuxao.agentdeck\shared-memory\memory.sqlite3` on Windows and `~/Library/Application Support/com.tuxao.agentdeck/shared-memory/memory.sqlite3` on macOS. Development state is isolated from production state. Personal settings and credentials do not travel with a checkout.

## Repository maintenance

The repository uses branch `main`. Maintainers with write access can commit reviewed changes and push to `origin/main`. Contributors should use a fork and pull request.

`scripts/publish-private.ps1` is retained as a utility for initial private publication. It checks the signed-in account, repository hygiene and private destination before pushing. It intentionally refuses an existing public destination and never changes repository visibility or force-pushes history. It is not needed to update this public repository.
