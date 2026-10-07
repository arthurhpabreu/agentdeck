// Deterministic, model-free benchmark of the installed RTK against raw output.
// All Git changes and RTK history stay in an isolated temporary fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workspace = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-token-benchmark-'));
const rtk = process.env.RTK_BINARY || 'rtk';
const environment = {
  ...process.env,
  RTK_DB_PATH: path.join(temporary, 'rtk-history.db'),
  RTK_TEE_DIR: path.join(temporary, 'rtk-tee'),
  RTK_TELEMETRY_DISABLED: '1',
  RTK_SUPPRESS_HOOK_WARNING: '1',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
};
function execute(command, args, expectedSuccess = true) {
  const result = spawnSync(command, args, {
    cwd: temporary, env: environment, encoding: 'utf8', windowsHide: true,
    timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  if (expectedSuccess) assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  return { code: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}
function measure(label, rawArgs, rtkArgs, verify) {
  const raw = execute(rawArgs[0], rawArgs.slice(1), false);
  const compact = execute(rtk, rtkArgs, false);
  assert.equal(compact.code, raw.code, `${label}: exit code changed`);
  const evidence = verify(raw.output, compact.output) || { inline_evidence_preserved: true, recovery_bytes: 0 };
  const rawBytes = Buffer.byteLength(raw.output, 'utf8');
  const compactBytes = Buffer.byteLength(compact.output, 'utf8');
  return {
    command: label,
    raw_bytes: rawBytes,
    compact_bytes: compactBytes,
    estimated_raw_tokens: Math.ceil(rawBytes / 4),
    estimated_compact_tokens: Math.ceil(compactBytes / 4),
    output_reduction_percent: Number(((1 - compactBytes / Math.max(1, rawBytes)) * 100).toFixed(2)),
    effective_bytes_including_recovery: compactBytes + evidence.recovery_bytes,
    effective_reduction_percent: Number(((1 - (compactBytes + evidence.recovery_bytes) / Math.max(1, rawBytes)) * 100).toFixed(2)),
    raw_exit_code: raw.code,
    compact_exit_code: compact.code,
    evidence_preserved: true,
    ...evidence,
  };
}
try {
  const version = execute(rtk, ['--version']).output.trim();
  const isolated = JSON.parse(execute(rtk, ['gain', '--format', 'json']).output);
  assert.equal(isolated.summary.total_commands, 0, 'RTK_DB_PATH must isolate the benchmark from user history');
  execute('git', ['init', '--quiet']);
  execute('git', ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(temporary, '.gitignore'), 'rtk-history.db*\nrtk-tee/\n');
  const filenames = Array.from({ length: 12 }, (_, i) => `module-${String(i).padStart(2, '0')}.js`);
  for (const filename of filenames) {
    fs.writeFileSync(path.join(temporary, filename), Array.from({ length: 16 }, (_, i) => `export const setting${i} = ${i};`).join('\n') + '\n');
  }
  execute('git', ['add', '.']);
  execute('git', ['-c', 'user.name=Agentdeck benchmark', '-c', 'user.email=benchmark@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Local test fixture']);
  for (const filename of filenames) {
    const original = fs.readFileSync(path.join(temporary, filename), 'utf8');
    fs.writeFileSync(path.join(temporary, filename), original.replace('export const setting8 = 8;', 'export const setting8 = 108; // BENCHMARK_CHANGED_VALUE'));
  }
  const status = measure('git status', ['git', 'status'], ['git', 'status'], (raw, compact) => {
    for (const filename of filenames) {
      assert.ok(raw.includes(filename), `raw status lost ${filename}`);
      assert.ok(compact.includes(filename), `compact status lost ${filename}`);
    }
  });
  const diff = measure('git diff', ['git', 'diff'], ['git', 'diff'], (raw, compact) => {
    for (const filename of filenames) {
      assert.ok(raw.includes(filename), `raw diff lost ${filename}`);
      assert.ok(compact.includes(filename), `compact diff lost ${filename}`);
    }
    for (const output of [raw, compact]) {
      assert.ok(output.includes('BENCHMARK_CHANGED_VALUE'), 'changed-line evidence must remain visible');
      assert.ok(output.includes('setting8 = 8'), 'deleted-line evidence must remain visible');
      assert.ok(output.includes('setting8 = 108'), 'added-line evidence must remain visible');
    }
  });
  const fixture = `const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nfor (let i = 0; i < 40; i++) test('passing case ' + i, () => assert.equal(2 + 2, 4));\ntest('FAILURE_SENTINEL', () => assert.equal('actual-value', 'expected-value', 'FAILURE_DETAIL_SENTINEL'));\n`;
  fs.writeFileSync(path.join(temporary, 'failure-fixture.test.cjs'), fixture);
  const failure = measure('node --test (one intentional failure)', ['node', '--test', '--test-reporter=spec', 'failure-fixture.test.cjs'], ['test', 'node', '--test', '--test-reporter=spec', 'failure-fixture.test.cjs'], (raw, compact) => {
    const sentinels = ['FAILURE_SENTINEL', 'FAILURE_DETAIL_SENTINEL'];
    for (const sentinel of sentinels) assert.ok(raw.includes(sentinel));
    if (sentinels.every((sentinel) => compact.includes(sentinel))) {
      return { inline_evidence_preserved: true, recovery_bytes: 0 };
    }
    // Some RTK versions keep only the tail of an unsupported test reporter.
    // Treat recovery as mandatory, and count its entire output against savings.
    const recoveryPath = compact.match(/\[full output: (.+)\]/)?.[1];
    assert.ok(recoveryPath, 'missing failure evidence requires a raw-output recovery path');
    const resolvedRecovery = path.resolve(recoveryPath);
    const allowedDirectory = path.resolve(environment.RTK_TEE_DIR);
    assert.equal(path.dirname(resolvedRecovery), allowedDirectory, 'raw recovery must stay in the isolated fixture');
    const recovered = fs.readFileSync(resolvedRecovery, 'utf8');
    for (const sentinel of sentinels) assert.ok(recovered.includes(sentinel), 'failure evidence must survive raw recovery');
    return { inline_evidence_preserved: false, raw_fallback_required: true, recovery_bytes: Buffer.byteLength(recovered, 'utf8') };
  });
  assert.notEqual(failure.compact_exit_code, 0, 'failing test must remain a failure');
  const results = [status, diff, failure];
  const rawTotal = results.reduce((sum, result) => sum + result.raw_bytes, 0);
  const compactTotal = results.reduce((sum, result) => sum + result.compact_bytes, 0);
  const effectiveTotal = results.reduce((sum, result) => sum + result.effective_bytes_including_recovery, 0);
  assert.ok(compactTotal < rawTotal, 'fixture must demonstrate a measured output reduction');
  const report = {
    benchmark: 'Local RTK output compaction; no model calls',
    generated_at: new Date().toISOString(),
    platform: process.platform,
    rtk_version: version,
    node_version: process.version,
    isolated_tracking_verified: true,
    fixture: { tracked_files_changed: filenames.length, passing_tests: 40, intentional_failing_tests: 1 },
    results,
    combined: { raw_bytes: rawTotal, compact_bytes: compactTotal, output_reduction_percent: Number(((1 - compactTotal / rawTotal) * 100).toFixed(2)), effective_bytes_including_recovery: effectiveTotal, effective_reduction_percent: Number(((1 - effectiveTotal / rawTotal) * 100).toFixed(2)) },
    limitations: [
      'Token counts are bytes/4 estimates, not model tokenizer measurements.',
      'This fixture measures tool output, not total chat tokens, paid usage, or subscription quota.',
      'Savings depend on the command and its output; unsupported commands can pass through without savings.',
      'Compressed output can omit context; agents must request raw output when needed for a reliable decision.',
      'The generic Node test wrapper on RTK 0.39 can hide diagnostics; raw recovery is verified and its bytes are counted. This can cancel savings for that command.',
    ],
  };
  const outputPath = path.join(workspace, 'docs', 'qa', 'token-economy-benchmark.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.match(path.basename(resolved), /^agentdeck-token-benchmark-[A-Za-z0-9]+$/);
  fs.rmSync(resolved, { recursive: true, force: true });
}
