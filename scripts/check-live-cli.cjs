// Read-only validation of installed CLI capabilities. No thread or model turn is started.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const npmRoot = path.join(process.env.APPDATA, "npm", "node_modules");
const codexScript = path.join(npmRoot, "@openai", "codex", "bin", "codex.js");
const claudeExe = path.join(npmRoot, "@anthropic-ai", "claude-code", "bin", "claude.exe");
const codex = args => spawnSync(process.execPath, [codexScript, ...args], { windowsHide: true, encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024 });

async function readConfiguration() {
  const child = spawn(process.execPath, [codexScript, "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"', "-c", 'hooks.PreToolUse=[{matcher="^Bash$",hooks=[{type="command",command="rtk --version",timeout=5}]}]', "app-server", "--listen", "stdio://"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  let buffer = "";
  const send = value => child.stdin.write(JSON.stringify(value) + "\n");
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Native configuration probe timed out")), 15000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", () => { clearTimeout(timer); reject(new Error("Native configuration probe exited early")); });
      child.stdout.on("data", chunk => {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message; try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1) {
            if (message.error) { clearTimeout(timer); reject(new Error("Native initialize rejected")); return; }
            send({ method: "initialized" });
            send({ id: 2, method: "config/read", params: { includeLayers: false, cwd: process.cwd() } });
          } else if (message.id === 2) {
            clearTimeout(timer);
            if (message.error) reject(new Error("Native configuration rejected"));
            else resolve(message.result.config);
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "agentdeck-validation", version: require("../package.json").version } } });
    });
  } finally {
    child.stdin.end();
    const stopped = await new Promise(resolve => { if (child.exitCode !== null) return resolve(true); const timer = setTimeout(() => resolve(false), 3000); child.once("exit", () => { clearTimeout(timer); resolve(true); }); });
    if (!stopped) spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  }
}

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-live-cli-"));
  try {
    const claude = spawnSync(claudeExe, ["--help"], { windowsHide: true, encoding: "utf8", timeout: 20000 });
    assert.equal(claude.status, 0);
    for (const flag of ["--replay-user-messages", "--input-format", "bypassPermissions"]) assert.ok(claude.stdout.includes(flag), `Claude lacks ${flag}`);
    const schema = codex(["app-server", "generate-json-schema", "--out", temporary]);
    assert.equal(schema.status, 0, "Codex schema generation failed");
    const collect = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? collect(path.join(directory, entry.name)) : entry.name.endsWith(".json") ? [fs.readFileSync(path.join(directory, entry.name), "utf8")] : []);
    const schemaText = collect(temporary).join("\n");
    assert.ok(schemaText.includes('"turn/steer"'));
    assert.ok(schemaText.includes('"expectedTurnId"'));
    const config = await readConfiguration();
    assert.equal(config.sandbox_mode, "danger-full-access");
    assert.equal(config.approval_policy, "never");
    const report = { checkedAt: new Date().toISOString(), codexVersion: codex(["--version"]).stdout.trim(), claudeVersion: spawnSync(claudeExe, ["--version"], { windowsHide: true, encoding: "utf8" }).stdout.trim(), claudeStreamingFlags: true, codexNativeSteerSchema: true, fullAccessConfiguration: true, modelTurnsStarted: 0 };
    fs.writeFileSync("docs/qa/live-cli-smoke.json", JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  } finally {
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(temporary).startsWith("agentdeck-live-cli-"));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
