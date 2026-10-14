import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { repositoryRoot, run } from "./desktop-tools.mjs";
import { checkVersion } from "./version.mjs";

const [command, platform] = process.argv.slice(2);
const version = checkVersion();
const directory = path.join(repositoryRoot, "release-assets");
fs.mkdirSync(directory, { recursive: true });
const expected = [
  `Agentdeck_${version}_x64-setup.exe`,
  `Agentdeck_${version}_x64_en-US.msi`,
  `Agentdeck_${version}_universal.dmg`,
  `Agentdeck_${version}_universal.app.tar.gz`,
  "LICENSE",
].sort();
const copy = source => fs.copyFileSync(source, path.join(directory, path.basename(source)));

if (command === "collect" && platform === "windows") {
  copy(path.join(repositoryRoot, "src-tauri/target/release/bundle/nsis", `Agentdeck_${version}_x64-setup.exe`));
  copy(path.join(repositoryRoot, "src-tauri/target/release/bundle/msi", `Agentdeck_${version}_x64_en-US.msi`));
} else if (command === "collect" && platform === "macos") {
  if (process.platform !== "darwin") throw new Error("macOS release collection requires a Mac to preserve application modes and symlinks.");
  const bundleDirectory = path.join(repositoryRoot, "src-tauri/target/universal-apple-darwin/release/bundle");
  copy(path.join(bundleDirectory, "dmg", `Agentdeck_${version}_universal.dmg`));
  run("/usr/bin/tar", ["-czf", path.join(directory, `Agentdeck_${version}_universal.app.tar.gz`), "-C", path.join(bundleDirectory, "macos"), "Agentdeck.app"]);
} else if (command === "checksums") {
  copy(path.join(repositoryRoot, "LICENSE"));
  const files = fs.readdirSync(directory).filter(name => name !== "SHA256SUMS.txt").sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error(`Release must contain both complete platform builds and LICENSE. Expected ${expected.join(", ")}; found ${files.join(", ")}.`);
  const lines = [];
  for (const name of files) {
    if (!fs.statSync(path.join(directory, name)).isFile()) throw new Error(`Release asset is not a regular file: ${name}`);
    const hash = createHash("sha256");
    await pipeline(fs.createReadStream(path.join(directory, name)), hash);
    lines.push(`${hash.digest("hex")}  ${name}`);
  }
  fs.writeFileSync(path.join(directory, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
  console.log(`Created one SHA256SUMS.txt for ${files.length} Windows/macOS assets and license.`);
} else {
  throw new Error("Usage: node scripts/release-assets.mjs collect windows|macos | checksums");
}
