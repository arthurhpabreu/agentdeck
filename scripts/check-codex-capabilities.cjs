// Metadata-only protocol probe. Never start a thread/turn or print config secrets.
const { spawn, spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const cli = join(process.env.APPDATA, 'npm/node_modules/@openai/codex/bin/codex.js');
const proc = spawn(process.execPath, [cli, 'app-server', '--listen', 'stdio://'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
const send = value => proc.stdin.write(JSON.stringify(value) + '\n');
const stop = () => { clearTimeout(timer); spawnSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); };
const timer = setTimeout(() => { console.error('Metadata timeout'); process.exitCode = 1; stop(); }, 15000);
createInterface({ input: proc.stdout }).on('line', line => {
  let v; try { v = JSON.parse(line); } catch { return; }
  if (v.id === 1) {
    send({ method: 'initialized' });
    send({ id: 2, method: 'model/list', params: { limit: 100, includeHidden: false } });
  }
  if (v.id === 2) {
    for (const model of v.result?.data ?? []) console.log(JSON.stringify({ model: model.model, default: model.isDefault, efforts: model.supportedReasoningEfforts?.map(value => value.reasoningEffort), additionalSpeedTiers: model.additionalSpeedTiers, serviceTiers: model.serviceTiers }));
    send({ id: 3, method: 'config/read', params: { includeLayers: false, cwd: process.cwd() } });
  }
  if (v.id === 3) {
    const config = v.result?.config || {};
    console.log(JSON.stringify({ configuredModel: config.model, profile: config.profile, configuredEffort: config.model_reasoning_effort, profileModel: config.profiles?.[config.profile]?.model, errorCode: v.error?.code }));
    stop();
  }
});
proc.on('error', error => { console.error(error.code); clearTimeout(timer); process.exitCode = 1; });
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agentdeck', version: '0.4.5' } } });
