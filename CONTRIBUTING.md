# Contributing to Agent Deck

Start with the [setup guide](docs/setup.md). Use a dedicated branch and keep pull requests focused on one behavior.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm check:i18n
corepack pnpm check:repo
corepack pnpm test:ui
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

Use Node.js 22.12+ and the pnpm version pinned in `package.json`. Commit both lockfiles when dependencies change. Desktop development also needs Rust and Tauri's platform prerequisites.

UI tests mock the native Tauri boundary and never submit model tasks. On a machine without Edge, set `PLAYWRIGHT_CHANNEL=chromium` and install Chromium through Playwright first. See [testing](docs/testing.md).

## Changes and review

- Use TypeScript for UI and Rust for privileged desktop operations.
- Keep provider credentials in the backend. Never put personal vaults, access tokens or real transcripts in fixtures.
- Add meaningful behavioral coverage for graph navigation, lifecycle handling and provider boundaries.
- Translate user-facing additions into English, Portuguese and Spanish; support keyboard navigation, light themes and reduced motion.
- Describe the problem, resulting behavior, checks performed and limitations in the pull request.
- Update the relevant English documentation and `CHANGELOG.md` when changing behavior.

Retain the Apache 2.0 license and existing copyright notices. Optional authenticated provider smoke scripts are local diagnostics, not CI prerequisites.
