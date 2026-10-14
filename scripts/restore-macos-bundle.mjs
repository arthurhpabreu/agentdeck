import fs from "node:fs";
import path from "node:path";
import { repositoryRoot, run } from "./desktop-tools.mjs";
import { checkVersion } from "./version.mjs";

if (process.platform !== "darwin") throw new Error("Restore macOS app bundles on a native Mac.");
const version = checkVersion();
const directory = path.join(repositoryRoot, "release-assets");
const bundles = path.join(repositoryRoot, "src-tauri/target/universal-apple-darwin/release/bundle");
fs.mkdirSync(path.join(bundles, "macos"), { recursive: true });
fs.mkdirSync(path.join(bundles, "dmg"), { recursive: true });
run("/usr/bin/tar", ["-xzf", path.join(directory, `Agentdeck_${version}_universal.app.tar.gz`), "-C", path.join(bundles, "macos")]);
fs.copyFileSync(path.join(directory, `Agentdeck_${version}_universal.dmg`), path.join(bundles, "dmg", `Agentdeck_${version}_universal.dmg`));
