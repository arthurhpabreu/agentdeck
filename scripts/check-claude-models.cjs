// Read Claude's SDK initialization catalogue without sending any user/model turn.
const { spawn, spawnSync } = require('node:child_process');
const { join } = require('node:path');
const cli = join(process.env.APPDATA, 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const child = spawn(cli, ['--safe-mode', '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--no-session-persistence'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
let pending = ''; let finished = false;
const stop = () => { clearTimeout(timer); if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); };
const timer = setTimeout(() => { if (!finished) { console.error('Model catalogue initialization timed out'); process.exitCode = 1; } stop(); }, 15000);
child.on('error', () => { console.error('Claude executable unavailable'); process.exitCode = 1; clearTimeout(timer); });
child.stdout.on('data', chunk => {
  pending += chunk.toString();
  let newline;
  while ((newline = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
    try {
      const event = JSON.parse(line);
      if (event.type !== 'control_response' || event.response?.request_id !== 'agentdeck-catalogue') continue;
      const response = event.response.response;
      console.log(JSON.stringify({ models: response?.models ?? [], result: event.response.subtype }, null, 2));
      finished = true; stop();
    } catch {}
  }
});
child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'agentdeck-catalogue', request: { subtype: 'initialize', hooks: {}, sdkMcpServers: [] } }) + '\n');
