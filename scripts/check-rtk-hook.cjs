// Exercise the packaged callback and real compression with an isolated database/repository.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const executable = path.resolve(process.argv[2] || "src-tauri/target/release/agentdeck.exe");
const rtkPath = spawnSync("where.exe", ["rtk"], { windowsHide: true, encoding: "utf8" }).stdout.trim().split(/\r?\n/).find(p => p.endsWith(".exe"));
assert.ok(rtkPath && fs.existsSync(executable));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-rtk-hook-"));
const env = { ...process.env, RTK_DB_PATH: path.join(temporary, "rtk.sqlite3") };
const run = (program, args, input) => {
  const result = spawnSync(program, args, { cwd: temporary, env, input, encoding: "utf8", windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, `${path.basename(program)} failed`);
  return result;
};
try {
  run("git", ["init", "--quiet"]);
  const message = path.join(temporary, "commit-message.txt");
  fs.writeFileSync(message, "Compression validation\n\n" + Array.from({ length: 150 }, (_, i) => `Fixture description ${i}: this disposable commit checks compression and command tracking.`).join("\n"));
  run("git", ["-c", "user.name=Agentdeck Validation", "-c", "user.email=validation@example.invalid", "commit", "--quiet", "--allow-empty", "-F", message]);
  const context = Buffer.from(JSON.stringify({ rtkPath, provider: "codex" })).toString("base64");
  const original = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git log", timeout_ms: 5000 } };
  const callback = run(executable, ["--rtk-hook", "--context", context], JSON.stringify(original));
  assert.equal(callback.stderr, "");
  const response = JSON.parse(callback.stdout);
  const hook = response.hookSpecificOutput;
  assert.equal(hook.permissionDecision, "allow");
  assert.equal(hook.updatedInput.command, "rtk git log");
  assert.equal(hook.updatedInput.timeout_ms, 5000);
  run(rtkPath, ["git", "log"]);
  const stats = JSON.parse(run(rtkPath, ["gain", "--format", "json"]).stdout);
  // RTK JSON keys are validated explicitly rather than inferring savings from chat tokens.
  const summary = stats.summary || stats;
  const commands = summary.total_commands ?? summary.command_count ?? summary.commands;
  const saved = summary.total_saved;
  const percentage = summary.avg_savings_pct;
  assert.ok(commands >= 1, "No tracked commands");
  assert.ok(saved > 0 && percentage > 0, "No measured compression");
  const report = { checkedAt: new Date().toISOString(), packagedCallback: true, originalArgumentsPreserved: true, commands, savedTokens: saved, savingsPercent: percentage, database: "isolated temporary RTK_DB_PATH", modelTurnsStarted: 0 };
  fs.writeFileSync("docs/qa/rtk-hook-smoke.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(temporary).startsWith("agentdeck-rtk-hook-"));
  fs.rmSync(temporary, { recursive: true, force: true });
}
