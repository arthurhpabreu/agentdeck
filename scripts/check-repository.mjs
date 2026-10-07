import fs from "node:fs";
import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
if (!files.length) throw new Error("No tracked files. Stage the intended project files before checking.");
const required = ["package.json", "pnpm-lock.yaml", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json", "src-tauri/capabilities/default.json", "LICENSE", "README.md", ".gitignore", "src-tauri/icons/icon.ico", ".github/workflows/ci.yml"];
const problems = required.filter(file => !files.includes(file)).map(file => `Required project input missing: ${file}`);
const obsoleteNamespace = new RegExp("code[-_]?" + "bar|\\.code" + "bar", "i");
const personalPath = new RegExp("[A-Z]:[/\\\\]Users[/\\\\]Arthur" + " Autis", "i");
const secrets = /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,}|sk-(?:proj-)?[A-Za-z0-9_-]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----(?:\r?\n|\\n)[A-Za-z0-9+/=]{40,})/;
const privateArtifact = /(^|\/)(?:node_modules|target|dist|test-results|playwright-report|\.local|\.codex|\.claude|\.gemini)(\/|$)|^docs\/(qa|local-archive)\/|(?:\.sqlite3?|\.db|\.pfx|\.p12|\.pem|\.key|\.log|\.msi|\.exe)$/i;
for (const file of files) {
  if (privateArtifact.test(file) || /(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith(".example")) problems.push(`Private/generated artifact tracked: ${file}`);
  if (!/\.(?:[cm]?js|tsx?|rs|css|json|toml|ya?ml|md|ps1|html|svg)$/.test(file)) continue;
  const content = fs.readFileSync(file, "utf8");
  if (obsoleteNamespace.test(content)) problems.push(`Obsolete app namespace: ${file}`);
  if (personalPath.test(content)) problems.push(`Personal machine path: ${file}`);
  if (secrets.test(content)) problems.push(`Potential credential: ${file}`);
}
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const tauri = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
const cargo = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
if (tauri.version !== pkg.version || cargo.match(/^version = "([^"]+)"/m)?.[1] !== pkg.version) problems.push("Frontend and native package versions differ.");
if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
else console.log(`Repository hygiene passed for ${files.length} tracked files; required inputs and versions verified.`);
