import { execFileSync, spawn } from 'node:child_process';

const address = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split('\n')[0];
const status = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' }));
const host = status.Self?.DNSName?.replace(/\.$/, '') || address;
if (!/^100\.\d+\.\d+\.\d+$/.test(address)) throw new Error('No Tailscale IPv4 address is available');
const env = {
  ...process.env,
  VITE_API_URL: `http://${host}:8787`,
  __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: host,
  WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || '.wrangler/dev.log',
  WRANGLER_SEND_METRICS: 'false',
};
const children = [
  spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'wrangler.api.jsonc', '--ip', address, '--port', '8787'], { env, stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', address, '--port', '5173', '--strictPort'], { env, stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => stop(code || 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log(`Dashboard: http://${host}:5173/`);
