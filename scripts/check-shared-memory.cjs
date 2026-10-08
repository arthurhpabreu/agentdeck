// Exercises the packaged Rust MCP transport through pipes; no model/provider calls.
// Usage: rtk node scripts/check-shared-memory.cjs [absolute-path-to-agentdeck.exe]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const workspace = path.resolve(__dirname, '..');
const executable = path.resolve(process.argv[2] || process.env.AGENTDECK_EXE || path.join(workspace, 'src-tauri', 'target', 'release', process.platform === 'win32' ? 'agentdeck.exe' : 'agentdeck'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-memory-smoke-'));
const dataDirectory = path.join(temporary, 'memory data');
const knowledgeConfig = path.join(temporary, 'knowledge.json');
const projects = { A: path.join(temporary, 'project A'), B: path.join(temporary, 'project B') };
const clients = [];
const results = [];
const defaultBudgetBytes = 800 * 4;
let requests = 0;
let failure;

class MemoryClient {
  constructor(project, provider = 'codex', session = 'smoke') {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.unexpected = [];
    this.stderrBytes = 0;
    this.closing = false;
    this.child = spawn(executable, [
      '--memory-mcp', '--data-dir', dataDirectory, '--project', project,
      '--session', session, '--provider', provider,
      '--knowledge-config', knowledgeConfig,
    ], { cwd: temporary, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.closed = new Promise((resolve) => {
      this.child.once('close', (code, signal) => {
        this.exit = { code, signal };
        if (this.buffer.trim()) this.fail(new Error('MCP stdout ended with an incomplete JSON line'));
        if (this.pending.size) this.fail(new Error('MCP exited before answering a request'));
        resolve(this.exit);
      });
    });
    this.child.on('error', (error) => this.fail(new Error(`MCP process failed: ${error.code || 'spawn'}`)));
    this.child.stdin.on('error', (error) => this.fail(new Error(`MCP input failed: ${error.code || 'pipe'}`)));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 1024 * 1024) return this.fail(new Error('MCP stdout exceeded the fixture buffer limit'));
      let end;
      while ((end = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let value;
        try { value = JSON.parse(line); } catch { this.fail(new Error('Non-JSON diagnostic appeared on MCP stdout')); continue; }
        const pending = this.pending.get(JSON.stringify(value.id));
        if (!pending) { this.unexpected.push(value); continue; }
        clearTimeout(pending.timer);
        this.pending.delete(JSON.stringify(value.id));
        pending.resolve(value);
      }
    });
    this.child.stderr.on('data', (chunk) => { this.stderrBytes += chunk.length; });
    clients.push(this);
  }

  fail(error) {
    this.error ||= error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  exchange(id, text) {
    if (this.error) return Promise.reject(this.error);
    if (this.exit) return Promise.reject(new Error('Request after MCP process exit'));
    requests += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(JSON.stringify(id));
        reject(new Error('MCP request timed out after 20 seconds'));
      }, 20_000);
      this.pending.set(JSON.stringify(id), { resolve, reject, timer });
      this.child.stdin.write(text + '\n', (error) => { if (error) this.fail(error); });
    });
  }

  async request(method, params = {}) {
    const id = this.nextId++;
    const response = await this.exchange(id, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, id);
    assert.equal(response.error, undefined, `Unexpected RPC error for ${method}`);
    return response.result;
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'agentdeck-local-smoke', version: '1.0.0' },
    });
    assert.equal(result.protocolVersion, '2024-11-05');
    assert.equal(result.serverInfo?.name, 'agentdeck-memory');
    assert.ok(result.instructions?.length > 0, 'Routing guidance must be supplied');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await this.request('ping');
    assert.equal(this.unexpected.length, 0, 'Notifications must not produce RPC responses');
  }

  async tool(name, args, expectError = false) {
    const result = await this.request('tools/call', { name, arguments: args });
    assert.equal(Boolean(result.isError), expectError, `${name} error state`);
    assert.ok(Array.isArray(result.content));
    return result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  }

  async close() {
    if (!this.exit) {
      this.closing = true;
      this.child.stdin.end();
      const killTimer = setTimeout(() => this.child.kill(), 5000);
      await this.closed;
      clearTimeout(killTimer);
    }
    return this.exit;
  }
}

async function step(name, run) {
  const started = Date.now();
  const evidence = await run();
  results.push({ name, passed: true, duration_ms: Date.now() - started, ...(evidence || {}) });
}

function saved(text) {
  const match = text.match(/^Saved ([A-Za-z0-9-]+) revision (\d+) /);
  assert.ok(match, 'Remember must identify the saved record and revision');
  return { id: match[1], revision: Number(match[2]) };
}

async function main() {
  assert.ok(fs.existsSync(executable), 'Build the Agentdeck executable before running this fixture');
  fs.mkdirSync(dataDirectory);
  for (const project of Object.values(projects)) fs.mkdirSync(project);
  const docs = path.join(temporary, 'selected documents'); fs.mkdirSync(docs);
  fs.writeFileSync(path.join(docs, 'oauth.md'), '# OAuth renewal\nVerify rotating refresh tokens. [[checks]]\n');
  fs.writeFileSync(path.join(docs, 'checks.md'), '# Checks\nValidate renewal failure boundaries.\n');
  fs.writeFileSync(knowledgeConfig, JSON.stringify({ sourcePath: docs }));
  const a = new MemoryClient(projects.A);
  let record;
  const note = { title: 'Aurora cursor contract', content: 'AURORA_SHARED_FACT: The cursor cache uses stable project keys in src/cache.ts. Validate cache behavior with the current tests before relying on this historical note.', kind: 'decision' };

  await step('initialize_and_scoped_tool_catalog', async () => {
    await a.initialize();
    const catalog = await a.request('tools/list');
    assert.deepEqual(catalog.tools.map((tool) => tool.name).sort(), ['documents_search', 'memory_projects', 'memory_read', 'memory_remember', 'memory_search']);
    for (const tool of catalog.tools) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.inputSchema.properties.project, undefined, 'Project scope must be supplied by the host');
      assert.equal(tool.annotations.readOnlyHint, tool.name !== 'memory_remember');
    }
    return { tools: catalog.tools.length, notification_response_count: a.unexpected.length };
  });

  await step('configured_documents_search_read_and_link_expansion', async () => {
    const found = await a.tool('documents_search', { query: 'OAuth renewal' });
    assert.ok(found.includes('oauth.md') && found.includes('checks.md'));
    const line = found.split('\n').find(line => line.startsWith('{') && JSON.parse(line).path === 'oauth.md');
    const hit = JSON.parse(line);
    const content = await a.tool('memory_read', { id: hit.id });
    assert.ok(content.includes('rotating refresh tokens'));
    await a.tool('memory_read', { id: 'doc:["global","../outside.md"]' }, true);
    assert.ok((await a.tool('memory_search', { query: 'OAuth renewal' })).includes('doc:'));
    await a.tool('memory_projects', {}, true);
    return { document_read: true, one_hop_link_found: true, traversal_denied: true, discovery_opt_in_required: true };
  });

  await step('native_capture_callback_keeps_structured_evidence_and_unicode', async () => {
    const context = Buffer.from(JSON.stringify({ directory: dataDirectory, project: projects.A, session: 'native-capture', provider: 'claude-code' })).toString('base64');
    const send = (payload) => new Promise((resolve, reject) => {
      let child;
      if (process.platform === 'win32') {
        const script = `$ProgressPreference = 'SilentlyContinue'; $OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = $OutputEncoding; $inputPayload = [Console]::In.ReadToEnd(); $inputPayload | & '${executable.replaceAll("'", "''")}' --memory-hook --context '${context}'`;
        child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } else child = spawn(executable, ['--memory-hook', '--context', context], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', errors = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk);
      const timer = setTimeout(() => { child.kill(); reject(new Error('Capture callback timed out')); }, 15_000);
      child.once('error', reject); child.once('close', code => { clearTimeout(timer); try { assert.equal(code, 0); assert.equal(errors, ''); assert.deepEqual(JSON.parse(output), {}); resolve(); } catch (error) { reject(error); } });
      child.stdin.end(JSON.stringify(payload));
    });
    await send({ hook_event_name: 'UserPromptSubmit', event_id: 'native-prompt', prompt: 'Corrigir renovação OAuth; por padrão prefiro português nas explicações' });
    await send({ hook_event_name: 'PostToolUse', tool_use_id: 'native-tool', tool_name: 'Write', tool_input: { file_path: 'src/auth.ts', content: 'BODY_MUST_NOT_BE_STORED' } });
    await send({ hook_event_name: 'PostToolUse', tool_use_id: 'native-test', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 } });
    await send({ hook_event_name: 'Stop', event_id: 'native-stop', last_assistant_message: 'Renovação corrigida; pendente verificar o login manualmente.' });
    const found = await a.tool('memory_search', { query: 'renovação' }); assert.ok(found.includes('renovação'));
    const db = new DatabaseSync(path.join(dataDirectory, 'shared-memory', 'memory.sqlite3'));
    try {
      const note = db.prepare("SELECT id,content,revision,verification FROM memory_records WHERE source_session_id='native-capture'").get();
      assert.ok(note.content.includes('src/auth.ts') && note.content.includes('exit code 0') && note.content.includes('pendente'));
      assert.ok(!note.content.includes('BODY_MUST_NOT_BE_STORED'));
      assert.equal(note.verification, 'auto-selected');
      const preference = db.prepare("SELECT source,verification FROM memory_records WHERE project_key='agentdeck:global'").get();
      assert.deepEqual({ ...preference }, { source: 'curation', verification: 'auto-selected' });
      assert.ok(db.prepare("SELECT count(*) AS n FROM memory_profile_candidates WHERE status='accepted'").get().n > 0);
      await send({ hook_event_name: 'UserPromptSubmit', event_id: 'native-followup', prompt: 'Também validar os testes do login' });
      await send({ hook_event_name: 'PostToolUse', tool_use_id: 'native-followup-test', tool_name: 'Bash', tool_input: { command: 'npm test login' }, tool_response: { exit_code: 0 } });
      await send({ hook_event_name: 'Stop', event_id: 'native-followup-stop', last_assistant_message: 'Testes do login concluídos; pendente conferir o navegador.' });
      const updated = new DatabaseSync(path.join(dataDirectory, 'shared-memory', 'memory.sqlite3'));
      try {
        const notes = updated.prepare("SELECT id,content,revision FROM memory_records WHERE source_session_id='native-capture'").all();
        assert.equal(notes.length, 1); assert.equal(notes[0].id, note.id); assert.ok(notes[0].revision > note.revision);
        assert.ok(notes[0].content.includes('src/auth.ts') && notes[0].content.includes('npm test login'));
      } finally { updated.close(); }
    } finally { db.close(); }
    return { unicode_roundtrip: true, files_and_verification_preserved: true, tool_body_excluded: true, durable_profile_auto_selected: true, followup_consolidated_without_duplicate: true };
  });

  await step('remember_search_read_and_idempotent_explicit_update', async () => {
    record = saved(await a.tool('memory_remember', note));
    const duplicate = saved(await a.tool('memory_remember', { ...note, id: record.id }));
    assert.deepEqual(duplicate, record, 'Identical explicit update must retain revision');
    const found = await a.tool('memory_search', { query: 'Aurora cursor' });
    assert.ok(found.includes(record.id) && found.includes('AURORA_SHARED_FACT'));
    const full = await a.tool('memory_read', { id: record.id });
    assert.ok(full.includes(note.content));
    return { initial_revision: record.revision, same_revision_after_identical_update: true };
  });

  await step('unavailable_vault_warns_without_hiding_saved_memories', async () => {
    fs.writeFileSync(knowledgeConfig, JSON.stringify({ sourcePath: path.join(temporary, 'unavailable fixture vault') }));
    try {
      const documents = await a.tool('documents_search', { query: 'OAuth renewal' });
      assert.ok(documents.includes('Document source warning') && documents.includes('unavailable'));
      const found = await a.tool('memory_search', { query: 'Aurora cursor' });
      assert.ok(found.includes('unavailable') && found.includes('AURORA_SHARED_FACT'));
    } finally {
      fs.writeFileSync(knowledgeConfig, JSON.stringify({ sourcePath: docs }));
    }
    const recovered = await a.tool('documents_search', { query: 'OAuth renewal' });
    assert.ok(recovered.includes('oauth.md') && !recovered.includes('Document source warning'));
    return { scoped_warning_visible: true, saved_memory_still_available: true, recovered_without_restarting: true };
  });

  const b = new MemoryClient(projects.B, 'gemini', 'smoke-b');
  await step('project_isolation_with_shared_database', async () => {
    await b.initialize();
    const result = await b.tool('memory_search', { query: 'Aurora cursor' });
    assert.ok(!result.includes('AURORA_SHARED_FACT') && !result.includes(record.id));
    const denied = await b.tool('memory_read', { id: record.id }, true);
    assert.ok(!denied.includes('AURORA_SHARED_FACT'));
    // Even a caller attempting to add an out-of-schema project cannot widen scope.
    const injected = await b.tool('memory_read', { id: record.id, project: projects.A }, true);
    assert.ok(!injected.includes('AURORA_SHARED_FACT'));
    return { cross_project_search_leak: false, cross_project_read_leak: false };
  });

  await step('missing_record_and_invalid_arguments', async () => {
    await a.tool('memory_read', { id: '00000000-0000-0000-0000-000000000000' }, true);
    await a.tool('memory_search', { query: '' }, true);
    await a.tool('memory_remember', { title: 'Invalid fixture', content: 'Synthetic invalid-kind memory', kind: 'instructions' }, true);
    return { expected_errors: 3 };
  });

  await step('malformed_json_recovery', async () => {
    const invalid = await a.exchange(null, '{invalid fixture JSON');
    assert.equal(invalid.error?.code, -32700);
    assert.equal(invalid.id, null);
    await a.request('ping');
    return { parse_error_code: -32700, subsequent_request_succeeded: true };
  });

  let longRecord;
  const longContent = 'ORBIT_MEMORY_BUDGET: ' + 'ação€🚀 '.repeat(500) + 'ORBIT_TAIL_EVIDENCE';
  await step('unicode_output_budget_and_targeted_tail_read', async () => {
    assert.ok(Buffer.byteLength(longContent) > defaultBudgetBytes && Buffer.byteLength(longContent) < 12000);
    longRecord = saved(await a.tool('memory_remember', { title: 'Orbit output budget', content: longContent, kind: 'fact' }));
    const head = await a.tool('memory_read', { id: longRecord.id });
    const tail = await a.tool('memory_read', { id: longRecord.id, offset: Buffer.byteLength(longContent) - 128 });
    const found = await a.tool('memory_search', { query: 'ORBIT_MEMORY_BUDGET' });
    const outputs = [head, tail, found];
    for (const text of outputs) {
      assert.ok(Buffer.byteLength(text) <= defaultBudgetBytes, 'MCP text exceeded the default retrieval budget');
      assert.ok(!text.includes('\uFFFD'), 'A multibyte character was split');
    }
    assert.ok(tail.includes('ORBIT_TAIL_EVIDENCE'));
    return { stored_input_bytes: Buffer.byteLength(longContent), text_budget_bytes: defaultBudgetBytes, read_head_bytes: Buffer.byteLength(head), read_tail_bytes: Buffer.byteLength(tail), search_bytes: Buffer.byteLength(found), tail_evidence_preserved: true };
  });

  await step('synthetic_credential_redaction', async () => {
    const synthetic = 'sk-proj-THIS_IS_SYNTHETIC_ONLY_123456789';
    const redacted = saved(await a.tool('memory_remember', { title: 'Synthetic redaction fixture', content: `Synthetic credential ${synthetic} must not appear in stored project evidence.`, kind: 'fact' }));
    const read = await a.tool('memory_read', { id: redacted.id });
    assert.ok(!read.includes(synthetic) && read.includes('REDACTED'));
    return { synthetic_token_removed: true };
  });

  await step('clean_eof_shutdown', async () => {
    assert.equal((await a.close()).code, 0);
    assert.equal((await b.close()).code, 0);
    return { exit_codes: [a.exit.code, b.exit.code] };
  });

  await step('restart_persistence_and_cross_provider_recall', async () => {
    const restarted = new MemoryClient(projects.A, 'claude-code', 'smoke-restarted');
    await restarted.initialize();
    const content = await restarted.tool('memory_read', { id: record.id });
    assert.ok(content.includes('AURORA_SHARED_FACT'));
    const found = await restarted.tool('memory_search', { query: 'Orbit output budget' });
    assert.ok(found.includes(longRecord.id));
    assert.equal((await restarted.close()).code, 0);
    return { saved_by: 'codex', recalled_by: 'claude-code', persisted_after_restart: true };
  });
}

(async () => {
  try { await main(); } catch (error) { failure = error; }
  finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    // Exact absolute target check before recursive deletion, entirely in Node.
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^agentdeck-memory-smoke-[A-Za-z0-9]+$/);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  const report = {
    fixture: 'Packaged Agentdeck MCP stdio, isolated temporary database; no model calls',
    generated_at: new Date().toISOString(), platform: process.platform, node_version: process.version,
    passed: !failure, tests_passed: results.length, rpc_requests: requests,
    process_count: clients.length, stderr_bytes: clients.reduce((total, client) => total + client.stderrBytes, 0),
    unexpected_rpc_responses: clients.reduce((total, client) => total + client.unexpected.length, 0),
    results,
    limitations: [
      'Tests real executable transport and scoped retrieval; no paid model calls or proof that a model will choose to call memory tools.',
      'Budget measures returned UTF-8 text bytes, not provider-tokenizer counts or JSON/schema overhead.',
      'Does not test UI capture, compaction delivery ledger, provider configuration, or disabled-memory settings; those require separate integration/unit checks.',
      'Idempotency check supplies the existing record ID; it does not claim semantic deduplication of arbitrary new notes.',
    ],
  };
  if (failure) report.failure = { name: failure.name, message: String(failure.message).split(temporary).join('<temporary-fixture>').split(executable).join('<agentdeck-executable>') };
  const target = path.join(workspace, 'docs', 'qa', 'shared-memory-smoke.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (failure) process.exitCode = 1;
})();
