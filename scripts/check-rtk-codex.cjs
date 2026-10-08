// Opt-in smoke test: the packaged adapter + installed RTK, no model requests.
// Usage: node scripts/check-rtk-codex.cjs <agentdeck.exe> <rtk.exe>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const executable = path.resolve(process.argv[2] || 'src-tauri/target/release/agentdeck.exe');
assert.ok(process.argv[3], 'Pass the absolute installed RTK executable path');
const rtk = path.resolve(process.argv[3]);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-rtk-codex-'));
const environment = { ...process.env, RTK_DB_PATH: path.join(temporary, 'measurements.db'), RTK_TELEMETRY_DISABLED: '1' };
const context = Buffer.from(JSON.stringify({ rtkPath: rtk, provider: 'codex' })).toString('base64');
function adapter(payload) {
  const result = spawnSync(executable, ['--rtk-hook', '--context', context], { input: JSON.stringify(payload), encoding: 'utf8', env: environment, cwd: temporary, windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0); return JSON.parse(result.stdout);
}
try {
  const payload = { session_id: 'rtk-codex-smoke', hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: temporary, tool_input: { command: 'git status', workdir: temporary, timeout_ms: 12000, yield_time_ms: 1000, max_output_tokens: 2000 } };
  const rewritten = adapter(payload).hookSpecificOutput;
  assert.equal(rewritten.hookEventName, 'PreToolUse'); assert.equal(rewritten.permissionDecision, 'allow');
  assert.equal(rewritten.updatedInput.command, 'rtk git status');
  assert.deepEqual(rewritten.updatedInput, { ...payload.tool_input, command: 'rtk git status' });
  assert.deepEqual(adapter({ ...payload, tool_input: rewritten.updatedInput }), {});
  assert.deepEqual(adapter({ ...payload, tool_name: 'apply_patch' }), {});
  assert.deepEqual(adapter({ ...payload, hook_event_name: 'PostToolUse' }), {});
  const init = spawnSync('git', ['init', '-q', temporary], { windowsHide: true }); assert.equal(init.status, 0);
  fs.writeFileSync(path.join(temporary, 'ação.txt'), 'Synthetic fixture');
  const run = spawnSync(rtk, ['git', 'status'], { cwd: temporary, env: environment, windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0); assert.ok(run.stdout.length > 0); assert.ok(fs.existsSync(environment.RTK_DB_PATH));
  console.log(JSON.stringify({ passed: true, checks: 5, codexRewriteContract: true, argumentsPreserved: true, doublePrefixPrevented: true, otherEventsUntouched: true, isolatedRtkCommandMeasured: true, modelRequests: 0, limitation: 'Exercises the actual adapter and RTK executable. Codex hook trust remains native; this does not claim a live model invoked the hook.' }));
} finally {
  const target = path.resolve(temporary);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.match(path.basename(target), /^agentdeck-rtk-codex-[A-Za-z0-9]+$/);
  fs.rmSync(target, { recursive: true, force: true });
}
