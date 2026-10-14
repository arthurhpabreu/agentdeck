import { desktopEnvironment, nodeBin, run } from "./desktop-tools.mjs";
import { checkVersion } from "./version.mjs";

const hostPlatform = { win32: "windows", darwin: "macos" }[process.platform];
const [requestedPlatform = hostPlatform, ...extraArgs] = process.argv.slice(2);
if (!hostPlatform || requestedPlatform !== hostPlatform) {
  throw new Error(`Build ${requestedPlatform || "desktop"} on its native Windows or macOS host; cross-compiling desktop installers is unsupported.`);
}
if (hostPlatform === "windows" && process.arch !== "x64") throw new Error("The Windows release currently targets x64.");
const version = checkVersion();
const args = ["build", "--bundles", hostPlatform === "macos" ? "app,dmg" : "nsis,msi"];
if (hostPlatform === "macos") args.push("--target", "universal-apple-darwin");
if (extraArgs.some(arg => ["--target", "--bundles", "--config", "--no-bundle"].includes(arg) || /^--(?:target|bundles|config)=/.test(arg))) {
  throw new Error("The release architecture, configuration and bundle types are fixed by the platform build script.");
}
args.push(...extraArgs, "--", "--locked");
const env = desktopEnvironment(hostPlatform === "macos" ? { MACOSX_DEPLOYMENT_TARGET: "11.0" } : {});
if (hostPlatform === "macos") {
  const identity = env.APPLE_SIGNING_IDENTITY?.trim() || "-";
  env.APPLE_SIGNING_IDENTITY = identity;
  const notarizationKeys = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_PATH"];
  for (const key of notarizationKeys) if (identity === "-" || !env[key]) delete env[key];
  if (identity !== "-") {
    const appleId = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"].every(key => env[key]);
    const apiKey = ["APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_PATH"].every(key => env[key]);
    if (!appleId && !apiKey) throw new Error("Developer ID releases require complete Apple ID or App Store Connect notarization credentials.");
  }
}
console.log(`Building Agentdeck ${version} for ${hostPlatform}${hostPlatform === "macos" ? " (Apple Silicon + Intel)" : " (x64)"}.`);
if (hostPlatform === "macos") run("rustup", ["target", "add", "aarch64-apple-darwin", "x86_64-apple-darwin"], { env });
run(process.execPath, [nodeBin("@tauri-apps/cli", "tauri"), ...args], { env });
