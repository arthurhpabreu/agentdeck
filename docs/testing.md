# Testing

```sh
corepack pnpm build
corepack pnpm check:i18n
corepack pnpm check:repo
corepack pnpm test:ui
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Build runs TypeScript checking before bundling. Translation checks validate EN/PT/ES key parity and interpolation. Repository checks inspect tracked inputs for obsolete namespaces, sensitive artifacts, personal paths and obvious secret formats; they complement a dedicated security scanner.

## Browser tests


Playwright provides Chromium and WebKit projects. Chromium defaults to installed Microsoft Edge locally and the Playwright browser in CI. Tests run the real React application against mocked native commands/events and never start coding agent tasks.

To use Chromium locally:

```powershell
corepack pnpm exec playwright install chromium
$env:PLAYWRIGHT_CHANNEL = 'chromium'
corepack pnpm test:ui --project=chromium
```

Focused checks: `corepack pnpm test:ui --project=chromium tests/e2e/knowledge.spec.ts tests/e2e/agents.spec.ts`.

For the macOS interface smoke, install WebKit and run `corepack pnpm test:ui --project=webkit --grep @macos`. `platform.spec.ts` covers native OS precedence over browser user-agent, POSIX resume commands, native login-shell arguments, Command clipboard shortcuts with Ctrl+C interruption, Mac window controls and manual DMG updates in all three languages. Browser checks do not substitute for native process or packaged-app checks.

Coverage includes a synthetic 1,600-note vault, complete-index lookup, folder drilldown, connection depth, zoom, modal focus restoration, agent/task selection, filters, active versus historical state and reduced motion. Other suites cover chat, permissions, memory, editor/workspace behavior, provider usage and economy. Telegram notification tests mock the native API to exercise private pairing, protected token input, explicit test sends, notification preferences, disconnect and recoverable errors without contacting Telegram or using real bot credentials. Traces and failure screenshots stay in ignored directories.

## Native tests

The Rust suite covers protocol parsing, provider boundaries, graph completeness, knowledge indexing, scoped memory, persistence and real native PTYs. Target-specific tests cover Unix socket hooks/statusline, UTF-8 shell output, Cocoa monitor coordinate conversion, Windows compatibility and verified DMG trailers/checksums. Tests marked `ignored` require installed tools, accounts or explicit network/install diagnostics; do not enable all ignored tests indiscriminately.

Optional `scripts/check-*.cjs` and `check-cli-controls.mjs` include installed-provider diagnostics. Read each script before use; some validate live authenticated features. They are not fresh-checkout prerequisites and are not invoked in CI.

`node scripts/check-rtk-codex.cjs <agentdeck.exe> <rtk.exe>` checks the packaged
Codex RTK adapter against an installed RTK executable. It verifies the canonical
hook payload, preserved command options, double-prefix protection and isolated
command measurements without model requests. It does not authorize a native
Codex hook or claim that a live model invoked one.

## CI and releases

CI installs pinned pnpm, Node.js 22 and Rust stable on Windows x64, macOS Apple Silicon (`macos-15`) and macOS Intel (`macos-15-intel`). Every target runs frontend, translation, repository/version and native Rust/fmt checks. Windows runs the full Chromium suite; both Macs run the tagged WebKit platform smoke without provider credentials.

Use the **Desktop release** workflow's manual dispatch for a packaging preview from a branch. It runs the complete validation matrix, builds Windows installers and a universal Mac application/DMG, validates architectures, deployment targets, metadata, bundled license and signing, then launches the same packaged application on Apple Silicon and Intel. Smoke reports/logs and available desktop screenshots are retained as workflow artifacts.

A validated `v*` tag produces one **draft** GitHub release after both platform builds and packaged Mac smoke jobs succeed. The final assembly requires all four installers/application packages, LICENSE and a shared checksum manifest. Review those artifacts before publishing. Do not tag unvalidated commits just to test CI.
Version 0.8 adds source-policy selection/migration fixtures, stable visual ordering, confirmed attention, diff review, contextual file navigation and checkpoint recovery. PTY tests verify one shared listener, byte-exact replay, Unicode input, interrupt fairness and view eviction without process restart. Chat activity tests verify the four-minute silence boundary and eight-second OAuth expiration independently. See [performance validation](validation/0.8.0-performance.md) for repeatable synthetic before/after loads.
