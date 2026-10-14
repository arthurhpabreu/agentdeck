import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { repositoryRoot, run } from "./desktop-tools.mjs";
import { checkVersion } from "./version.mjs";

const tag = process.env.GITHUB_REF_NAME;
checkVersion(tag);
if (!process.env.GITHUB_REF?.startsWith("refs/tags/v")) throw new Error("Release creation is only allowed for version tags.");
const directory = path.join(repositoryRoot, "release-assets");
if (!fs.existsSync(path.join(directory, "SHA256SUMS.txt"))) throw new Error("Aggregate release checksums are missing.");
const assets = fs.readdirSync(directory).sort().map(name => path.join(directory, name));
const existing = spawnSync("gh", ["release", "view", tag, "--json", "isDraft", "--jq", ".isDraft"], { encoding: "utf8", cwd: repositoryRoot, shell: false });
if (existing.status === 0) {
  if (existing.stdout.trim() !== "true") throw new Error(`Release ${tag} is already published; published assets are immutable.`);
  run("gh", ["release", "upload", tag, ...assets, "--clobber"]);
} else {
  run("gh", ["release", "create", tag, ...assets, "--verify-tag", "--draft", "--generate-notes", "--title", `Agentdeck ${tag}`]);
}
console.log(`Complete Windows/macOS draft release ${tag} is ready for review.`);
