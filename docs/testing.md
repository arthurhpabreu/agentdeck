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

Playwright defaults to installed Microsoft Edge locally and Chromium in CI. Tests run the real React application against mocked native commands/events and never start coding agent tasks.

To use Chromium locally:

```powershell
corepack pnpm exec playwright install chromium
$env:PLAYWRIGHT_CHANNEL = 'chromium'
corepack pnpm test:ui
```

Focused checks: `corepack pnpm test:ui tests/e2e/knowledge.spec.ts tests/e2e/agents.spec.ts`.

Coverage includes a synthetic 1,600-note vault, complete-index lookup, folder drilldown, connection depth, zoom, modal focus restoration, agent/task selection, filters, active versus historical state and reduced motion. Other suites cover chat, permissions, memory, editor/workspace behavior, provider usage and economy. Traces and failure screenshots stay in ignored directories.

## Native tests

The Rust suite covers protocol parsing, provider boundaries, graph completeness, knowledge indexing, scoped memory, persistence and a real Windows PTY. Tests marked `ignored` require installed tools, accounts or explicit network/install diagnostics; do not enable all ignored tests indiscriminately.

Optional `scripts/check-*.cjs` and `check-cli-controls.mjs` include installed-provider diagnostics. Read each script before use; some validate live authenticated features. They are not fresh-checkout prerequisites and are not invoked in CI.

## CI and releases

Windows CI installs pinned pnpm, Node.js 22 and Rust stable, and runs frontend, translation, repository, browser and Rust checks without provider credentials.

A `v*` tag builds Windows installers and creates a **draft** GitHub release. Review artifacts, checksums and metadata before publishing it. Do not tag unvalidated commits just to test CI.
