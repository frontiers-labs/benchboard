import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const required = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'BENCHBOARD_SUBMIT_TOKEN', 'BENCHBOARD_CANDIDATE_TOKEN', 'BENCHBOARD_API_URL'];
for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}`);
const apiAddress = new URL(process.env.BENCHBOARD_API_URL);
if (apiAddress.protocol !== 'https:' || apiAddress.username || apiAddress.password || apiAddress.pathname !== '/' || apiAddress.search || apiAddress.hash) throw new Error('BENCHBOARD_API_URL must be an HTTPS origin');
const apiUrl = apiAddress.origin;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!/^[a-f0-9]{32}$/.test(account)) throw new Error('Invalid Cloudflare account ID');
const apiBase = `https://api.cloudflare.com/client/v4/accounts/${account}`;
async function cloudflare(path, method = 'GET', body, allowMissing = false) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 404 && allowMissing) return null;
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(`Cloudflare ${method} ${path}: ${response.status} ${JSON.stringify(data.errors)}`);
  return data.result;
}
function command(program, args, { env = {}, input } = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(program, args, { env: { ...process.env, ...env }, stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveCommand() : reject(new Error(`${program} ${args[0]} exited ${code}`)));
    if (input !== undefined) child.stdin.end(input);
  });
}
const wrangler = (...args) => command(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args]);
const base = JSON.parse(await readFile('wrangler.api.jsonc', 'utf8'));
const pages = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
const databaseName = base.d1_databases[0].database_name;
const matches = (await cloudflare(`/d1/database?name=${encodeURIComponent(databaseName)}&per_page=100`)).filter(db => db.name === databaseName);
if (matches.length > 1) throw new Error('More than one matching D1 database');
const database = matches[0] || await cloudflare('/d1/database', 'POST', { name: databaseName });
if (!database.uuid) throw new Error('D1 returned no database ID');
console.log(`Using D1 ${databaseName} (${database.uuid})`);
await mkdir('.wrangler/deploy', { recursive: true });
const config = resolve('.wrangler/deploy/api.json');
await writeFile(config, JSON.stringify({ ...base, account_id: account, workers_dev: true, main: resolve(base.main), d1_databases: [{ ...base.d1_databases[0], database_id: database.uuid, migrations_dir: resolve('migrations') }] }, null, 2));
await wrangler('d1', 'migrations', 'apply', databaseName, '--remote', '--config', config);
await wrangler('deploy', '--config', config);
await command(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'bulk', '--config', config], {
  input: JSON.stringify({ SUBMIT_TOKEN: process.env.BENCHBOARD_SUBMIT_TOKEN, CANDIDATE_TOKEN: process.env.BENCHBOARD_CANDIDATE_TOKEN }),
});
let project = await cloudflare(`/pages/projects/${pages.name}`, 'GET', undefined, true);
if (!project) project = await cloudflare('/pages/projects', 'POST', { name: pages.name, production_branch: 'master' });
if (project.production_branch !== 'master') throw new Error('Existing Pages project must use master as its production branch');
await command('npm', ['run', 'build'], { env: { VITE_API_URL: apiUrl } });
await wrangler('pages', 'deploy', 'dist', '--project-name', pages.name, '--branch', 'master');
const uiUrl = `https://${project.subdomain}`;
// Deployment can finish before its hostname is serving the new version.
async function verify(url, validate) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (response.ok && await validate(response)) return;
    } catch { /* Retry propagation failures. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 5_000));
  }
  throw new Error(`Deployed endpoint did not pass verification: ${url}`);
}
await verify(`${apiUrl}/api/runs?limit=1`, async response => Array.isArray((await response.json()).runs));
await verify(uiUrl, async response => (await response.text()).includes('id="app"'));
const summary = `API: ${apiUrl}\nDashboard: ${uiUrl}\nD1: ${database.uuid}\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
