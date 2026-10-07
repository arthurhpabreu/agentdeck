// Read-only check of the packaged collector. Uses the existing Claude login;
// queries subscription usage only, without starting a chat or spending model tokens.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const executable = path.resolve(process.argv[2] || path.join(root, 'src-tauri', 'target', 'release', process.platform === 'win32' ? 'agentdeck.exe' : 'agentdeck'));
const result = spawnSync(executable, ['--check-claude-usage'], {
  encoding: 'utf8', windowsHide: true, timeout: 25_000, maxBuffer: 256 * 1024,
});
function fail(message) { console.error(message); process.exit(1); }
if (result.error || result.status !== 0) fail('Claude usage diagnostic did not exit successfully. Raw process output withheld.');
if (/access[_-]?token|refresh[_-]?token|authorization|bearer|sk-ant-/i.test(result.stdout + result.stderr)) {
  fail('Unexpected credential-related output; output withheld.');
}
if (result.stderr.trim()) fail('Unexpected diagnostic stderr; output withheld.');
let usage;
try { usage = JSON.parse(result.stdout); } catch { fail('Expected sanitized usage JSON from the packaged collector.'); }
const allowed = ['provider', 'status', 'windows', 'observed_at', 'source', 'reason', 'retry_at'];
if (Object.keys(usage).some(key => !allowed.includes(key))) fail('Unexpected diagnostic fields; output withheld.');
if (usage.provider !== 'claude-code' || usage.source !== 'claude-oauth' || usage.status !== 'ready' || !Array.isArray(usage.windows) || !usage.windows.length) {
  // Only fixed status identifiers leave this branch; never a remote error body.
  const reason = ['missing-login', 'expired-login', 'authentication', 'rate-limited', 'network', 'unsupported', 'read-error', 'unavailable'].includes(usage.reason) ? usage.reason : 'unknown';
  fail('No live subscription reading available: ' + reason);
}
const windows = usage.windows.map(item => {
  if (!Number.isFinite(item.used_percent) || item.used_percent < 0 || typeof item.key !== 'string' || !/^[a-z0-9-]+$/.test(item.key)) fail('Invalid quota window returned.');
  if (Object.keys(item).some(key => !['key', 'used_percent', 'window_minutes', 'resets_at', 'observed_at'].includes(key))) fail('Unexpected quota fields; output withheld.');
  return { key: item.key, used_percent: item.used_percent, resets_at: item.resets_at ?? null };
});
const report = {
  generated_at: new Date().toISOString(),
  fixture: 'Agentdeck executable collector using the existing Claude subscription login; read-only, no model calls',
  passed: true,
  source: usage.source,
  observed_at: usage.observed_at,
  windows,
  stderr_bytes: Buffer.byteLength(result.stderr),
  credentials_in_output: false,
  limitations: ['One real account and one request; offline/error/backoff cases are covered separately by unit and UI tests.', 'Monthly windows are present only if the account reports a supported monthly budget.'],
};
const destination = path.join(root, 'docs', 'qa', 'claude-usage-smoke.json');
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
