import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { repositoryRoot, run } from "./desktop-tools.mjs";
import { checkVersion } from "./version.mjs";

if (process.platform !== "darwin") throw new Error("macOS bundle verification requires a native Mac.");
const app = path.join(repositoryRoot, "src-tauri/target/universal-apple-darwin/release/bundle/macos/Agentdeck.app");
const plist = path.join(app, "Contents/Info.plist");
const reportDirectory = path.join(repositoryRoot, "native-smoke-results");
fs.mkdirSync(reportDirectory, { recursive: true });

function capture(command, args) {
  return run(command, args, { encoding: "utf8", stdio: "pipe", timeout: 30_000 }).stdout.trim();
}
const config = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "src-tauri/tauri.conf.json"), "utf8"));
const macConfig = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "src-tauri/tauri.macos.conf.json"), "utf8"));
const version = checkVersion();
const property = key => capture("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist]);
const metadata = {
  identifier: property("CFBundleIdentifier"),
  version: property("CFBundleShortVersionString"),
  bundleVersion: property("CFBundleVersion"),
  minimumSystemVersion: property("LSMinimumSystemVersion"),
  executable: property("CFBundleExecutable"),
};
if (metadata.identifier !== config.identifier || metadata.version !== version.replace(/-.+$/, "") || metadata.bundleVersion !== version.replace(/-.+$/, "")) {
  throw new Error(`Packaged application identity/version differs from manifests: ${JSON.stringify(metadata)}`);
}
if (metadata.minimumSystemVersion !== macConfig.bundle.macOS.minimumSystemVersion) throw new Error("Packaged minimum macOS version differs from the platform configuration.");
const executable = path.join(app, "Contents/MacOS", metadata.executable);
run("/usr/bin/lipo", [executable, "-verify_arch", "arm64", "x86_64"]);
metadata.architectures = capture("/usr/bin/lipo", ["-archs", executable]).split(/\s+/).sort();
if (metadata.architectures.join(",") !== "arm64,x86_64") throw new Error("The application must contain exactly Apple Silicon and Intel architectures.");
metadata.minimumOSByArchitecture = {};
function newerThan(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    if ((leftParts[index] || 0) !== (rightParts[index] || 0)) return (leftParts[index] || 0) > (rightParts[index] || 0);
  }
  return false;
}
for (const architecture of metadata.architectures) {
  const commands = capture("/usr/bin/otool", ["-arch", architecture, "-l", executable]);
  const minimum = commands.match(/cmd LC_BUILD_VERSION[\s\S]*?\bminos\s+([\d.]+)/)?.[1]
    || commands.match(/cmd LC_VERSION_MIN_MACOSX[\s\S]*?\bversion\s+([\d.]+)/)?.[1];
  if (!minimum || newerThan(minimum, metadata.minimumSystemVersion)) {
    throw new Error(`${architecture} Mach-O deployment target ${minimum || "missing"} exceeds the declared macOS minimum ${metadata.minimumSystemVersion}.`);
  }
  metadata.minimumOSByArchitecture[architecture] = minimum;
}
const bundledLicense = fs.readFileSync(path.join(app, "Contents/Resources/LICENSE"));
if (!bundledLicense.equals(fs.readFileSync(path.join(repositoryRoot, "LICENSE")))) throw new Error("The application bundle must contain the project license unchanged.");
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
const signature = run("/usr/bin/codesign", ["-d", "--verbose=4", app], { encoding: "utf8", stdio: "pipe" });
metadata.signing = /Signature=adhoc/.test(signature.stderr) ? "ad-hoc" : "Developer ID";
if (metadata.signing === "Developer ID") {
  run("/usr/bin/xcrun", ["stapler", "validate", app]);
  run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
  metadata.notarized = true;
} else {
  metadata.notarized = false;
}
const dmgDirectory = path.join(repositoryRoot, "src-tauri/target/universal-apple-darwin/release/bundle/dmg");
const diskImages = fs.readdirSync(dmgDirectory).filter(name => name.endsWith(".dmg"));
if (diskImages.length !== 1) throw new Error(`Expected one release DMG, found ${diskImages.length}.`);
run("/usr/bin/hdiutil", ["verify", path.join(dmgDirectory, diskImages[0])]);
fs.writeFileSync(path.join(reportDirectory, "bundle-validation.json"), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Verified universal macOS bundle ${version}, minimum ${metadata.minimumSystemVersion}, signing ${metadata.signing}.`);

if (process.argv.includes("--smoke")) {
  // A short fixture path also respects Darwin's Unix-socket pathname limit.
  const helperDirectory = fs.mkdtempSync("/tmp/agentdeck-smoke-");
  const helperEnvironment = { ...process.env, HOME: helperDirectory, AGENTDECK_SESSION_ID: "native-smoke-session", AGENTDECK_RUNNER_TYPE: "codex" };
  const statusline = run(executable, ["--claude-statusline"], {
    env: helperEnvironment, stdio: "pipe", encoding: "utf8", timeout: 10_000,
    input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42, resets_at: 2_000_000_000 } }, prompt: "native-smoke-private-sentinel", cwd: "/private/fixture" }),
  });
  if (statusline.stdout.trim() !== "Agentdeck") throw new Error("Packaged Claude statusline helper did not respond correctly.");
  const usageFile = path.join(helperDirectory, ".agentdeck/usage/claude.json");
  const usage = JSON.parse(fs.readFileSync(usageFile, "utf8"));
  if (usage.rate_limits?.five_hour?.used_percentage !== 42 || JSON.stringify(usage).includes("native-smoke-private-sentinel") || usage.cwd) throw new Error("Packaged statusline helper did not preserve the quota or sanitize private fields.");
  if ((fs.statSync(usageFile).mode & 0o777) !== 0o600) throw new Error("Packaged quota cache must be owner-readable/writable only.");
  const runtimeDirectory = path.join(helperDirectory, ".agentdeck/run");
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  for (const [source, suffix] of [["codex", "codex"], ["claude-code", "claude"]]) {
    const socketPath = path.join(runtimeDirectory, `agentdeck-hook-${suffix}.sock`);
    const sockets = new Set();
    let receive;
    const received = new Promise(resolve => { receive = resolve; });
    const server = net.createServer(socket => {
      sockets.add(socket);
      socket.setEncoding("utf8");
      let body = "";
      socket.on("data", chunk => { body += chunk; });
      socket.on("end", () => { receive(body); });
      socket.on("error", () => {});
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    let timer;
    try {
      run(executable, ["--hook-bridge", "--source", source, "--socket", socketPath], {
        env: { ...helperEnvironment, AGENTDECK_RUNNER_TYPE: source }, stdio: "pipe", encoding: "utf8", timeout: 10_000,
        input: JSON.stringify({ hook_event_name: "Stop", message: "ação 🧪", session_id: "provider-fixture" }),
      });
      const body = await Promise.race([received, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`Packaged ${source} hook bridge did not reach the Unix socket.`)), 4_000); })]);
      const payload = JSON.parse(body);
      if (payload.message !== "ação 🧪" || payload.agentdeck_source !== source || payload.agentdeck_runner_type !== source || payload.agentdeck_session_id !== "native-smoke-session" || payload.session_id !== "provider-fixture") throw new Error(`Packaged ${source} hook bridge lost Unicode or routing context.`);
    } finally {
      clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  }
  metadata.nativeHelpers = { claudeStatusline: true, sanitizedQuotaCache: true, codexUnixSocket: true, claudeUnixSocket: true, unicode: true };
  console.log("Verified packaged statusline quota sanitization and Unicode delivery through both native hook bridges.");
  const crashDirectory = path.join(os.homedir(), "Library/Logs/DiagnosticReports");
  const reports = () => fs.existsSync(crashDirectory) ? fs.readdirSync(crashDirectory).filter(name => /agentdeck/i.test(name)) : [];
  const previousReports = new Set(reports());
  const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-native-smoke-"));
  const log = fs.openSync(path.join(reportDirectory, "application.log"), "w");
  const child = spawn(executable, [], {
    cwd: isolatedCwd,
    env: { ...process.env, RUST_BACKTRACE: "1" },
    stdio: ["ignore", log, log],
    shell: false,
  });
  let spawnError;
  child.on("error", error => { spawnError = error; });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    await pause(5_000);
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Packaged GUI exited before a reopen event could be sent.");
    // Send a standard Dock/Finder reopen event to show the workbench.
    run("/usr/bin/open", ["-a", app], { timeout: 15_000 });
    await pause(15_000);
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Packaged GUI exited during startup (${child.exitCode || child.signalCode}).`);
    const output = fs.readFileSync(path.join(reportDirectory, "application.log"), "utf8");
    if (/thread .+ panicked|fatal runtime error|dyld\[[^\]]+\]:.*(?:not loaded|not found)/i.test(output)) throw new Error("Packaged GUI logged a fatal startup error; inspect application.log.");
    const newReports = reports().filter(name => !previousReports.has(name));
    for (const name of newReports) fs.copyFileSync(path.join(crashDirectory, name), path.join(reportDirectory, name));
    if (newReports.length) throw new Error(`Packaged GUI generated crash reports: ${newReports.join(", ")}`);
    const screenshot = spawnSync("/usr/sbin/screencapture", ["-x", path.join(reportDirectory, "desktop.png")], { timeout: 10_000, encoding: "utf8" });
    metadata.smoke = { startupSeconds: 20, runnerArchitecture: process.arch, alive: true, screenshotCaptured: screenshot.status === 0 };
    fs.writeFileSync(path.join(reportDirectory, "bundle-validation.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    console.log(`Packaged GUI stayed alive for 20 seconds without fatal logs/crash reports; screenshot ${metadata.smoke.screenshotCaptured ? "captured" : "unavailable on this runner"}.`);
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), pause(5_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    fs.closeSync(log);
  }
}
