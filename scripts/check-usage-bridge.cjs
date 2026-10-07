// Development validation: exercises the Windows bridge in an isolated temp directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../src-tauri/src/provider_usage.rs'), 'utf8');
const script = source.match(/const CLAUDE_STATUSLINE_PS: &str = r#"([\s\S]*?)"#;/)?.[1];
assert.ok(script);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-usage-test-'));
try {
  const scriptPath = path.join(temporary, 'claude-statusline.ps1');
  fs.writeFileSync(scriptPath, script);
  const fixture = { session_id: 'private-fixture', cwd: 'private-fixture', rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 2000000000, unrelated: 'must-not-persist' }, seven_day: { used_percentage: 42 }, spend_limit: { used_percentage: 62, period: 'monthly' } } };
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { input: JSON.stringify(fixture), encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(fs.readFileSync(path.join(temporary, 'claude.json'), 'utf8'));
  assert.deepEqual(actual, { rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 2000000000 }, seven_day: { used_percentage: 42 }, spend_limit: { used_percentage: 62, period: 'monthly' } } });
  assert.equal(result.stdout, 'AgentDeck');
  for (const empty of [{ session_id: 'initializing' }, { rate_limits: {} }]) {
    const followup = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { input: JSON.stringify(empty), encoding: 'utf8', windowsHide: true });
    assert.equal(followup.status, 0, followup.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temporary, 'claude.json'), 'utf8')), actual, 'An empty startup payload must preserve the last valid usage snapshot.');
  }
  console.log('Usage statusline bridge: passed (5h, weekly, monthly; private fields excluded; empty startup payload preserves last reading).');
} finally {
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.match(path.basename(resolved), /^agentdeck-usage-test-[A-Za-z0-9]+$/);
  fs.rmSync(resolved, { recursive: true, force: true });
}
