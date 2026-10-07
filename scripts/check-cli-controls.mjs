// Offline config parsing only: never start a model turn or send a prompt.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const cli = join(process.env.APPDATA, 'npm/node_modules/@openai/codex/bin/codex.js');
for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
  const fast = effort === 'ultra';
  const args = [cli, '-c', `model_reasoning_effort="${effort}"`, '-c', `service_tier="${fast ? 'fast' : 'default'}"`, '-c', `features.fast_mode=${fast}`, 'features', 'list'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  console.log(JSON.stringify({ effort, fast, status: result.status, error: result.stderr?.slice(0, 600) }));
  if (result.status !== 0) process.exitCode = 1;
}
