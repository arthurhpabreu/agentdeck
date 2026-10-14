import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repositoryRoot, "package.json"));

export function nodeBin(packageName, binName) {
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = require(manifestPath);
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
  if (!bin) throw new Error(`Missing ${binName} executable in ${packageName}; install dependencies first.`);
  return path.resolve(path.dirname(manifestPath), bin);
}

export function desktopEnvironment(overrides = {}) {
  return {
    ...process.env,
    PATH: `${path.join(os.homedir(), ".cargo", "bin")}${path.delimiter}${process.env.PATH || ""}`,
    ...overrides,
  };
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: desktopEnvironment(),
    stdio: "inherit",
    windowsHide: true,
    ...options,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.signal || result.status}).`);
  return result;
}

export function spawnTauri(args, env = desktopEnvironment()) {
  // Run the installed JavaScript entry with Node. Directly spawning a .cmd shim
  // is unsupported by modern Node on Windows; a shell also damages JSON args.
  return spawn(process.execPath, [nodeBin("@tauri-apps/cli", "tauri"), ...args], {
    cwd: repositoryRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
}
