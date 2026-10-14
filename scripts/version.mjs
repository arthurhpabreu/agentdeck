import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "./desktop-tools.mjs";

const packagePath = path.join(repositoryRoot, "package.json");
const tauriPath = path.join(repositoryRoot, "src-tauri/tauri.conf.json");
const cargoPath = path.join(repositoryRoot, "src-tauri/Cargo.toml");
const lockPath = path.join(repositoryRoot, "src-tauri/Cargo.lock");
const cargoVersion = /(\[package\][\s\S]*?\nversion\s*=\s*")([^"]+)(")/;
const lockVersion = /(\[\[package\]\]\r?\nname = "agentdeck"\r?\nversion = ")([^"]+)(")/;

export function validateSemver(version) {
  const numeric = "(?:0|[1-9]\\d*)";
  const identifier = "(?:0|[1-9]\\d*|[\\dA-Za-z-]*[A-Za-z-][\\dA-Za-z-]*)";
  const semver = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?$`);
  if (!semver.test(version)) throw new Error(`Invalid release SemVer: ${version}. Use major.minor.patch with an optional prerelease.`);
}

export function checkVersion(tag) {
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const tauri = JSON.parse(fs.readFileSync(tauriPath, "utf8"));
  const cargo = fs.readFileSync(cargoPath, "utf8").match(cargoVersion)?.[2];
  const lock = fs.readFileSync(lockPath, "utf8").match(lockVersion)?.[2];
  validateSemver(pkg.version);
  const versions = { "package.json": pkg.version, "tauri.conf.json": tauri.version, "Cargo.toml": cargo, "Cargo.lock": lock };
  if (Object.values(versions).some(version => version !== pkg.version)) {
    throw new Error(`Version mismatch: ${JSON.stringify(versions)}. Run pnpm version:set <version>.`);
  }
  if (tag && tag !== `v${pkg.version}`) throw new Error(`Tag ${tag} must match v${pkg.version}.`);
  return pkg.version;
}

function setVersion(version) {
  validateSemver(version);
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const tauri = JSON.parse(fs.readFileSync(tauriPath, "utf8"));
  const cargo = fs.readFileSync(cargoPath, "utf8");
  const lock = fs.readFileSync(lockPath, "utf8");
  if (!cargoVersion.test(cargo) || !lockVersion.test(lock)) throw new Error("Application version is missing from a Rust manifest.");
  pkg.version = version;
  tauri.version = version;
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`);
  fs.writeFileSync(cargoPath, cargo.replace(cargoVersion, (_, before, old, after) => `${before}${version}${after}`));
  fs.writeFileSync(lockPath, lock.replace(lockVersion, (_, before, old, after) => `${before}${version}${after}`));
  console.log(`Synchronized application manifests to ${checkVersion()}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = "check", value] = process.argv.slice(2);
  if (command === "set" && value) setVersion(value);
  else if (command === "check" || command === "check-tag") {
    const tag = command === "check-tag" ? process.env.GITHUB_REF_NAME : value;
    if (command === "check-tag" && !process.env.GITHUB_REF?.startsWith("refs/tags/")) throw new Error("check-tag requires a GitHub version-tag event.");
    console.log(`Application SemVer ${checkVersion(tag)} is synchronized across all four manifests.`);
  } else throw new Error("Usage: node scripts/version.mjs check [vX.Y.Z] | check-tag | set X.Y.Z");
}
