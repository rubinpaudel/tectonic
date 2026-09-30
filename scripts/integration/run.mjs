import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://tunnelvision:tunnelvision@127.0.0.1:55432/tunnelvision' };
async function run(command, args) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
  const forward = (signal) => child.kill(signal);
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? signal}`)));
    });
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}
const [mode, ...args] = process.argv.slice(2);
try {
  if (mode === 'demo') {
    await run('docker', ['compose', '-p', 'tunnelvision', 'up', '-d', '--wait', 'postgres']);
    await run('pnpm', ['--config.verify-deps-before-run=false', 'build']);
    await run(process.execPath, ['packages/db/dist/cli.js']);
    await run(process.execPath, ['apps/ingest-cli/dist/index.js', '--tenant', 'nike', '--path', './mock-data/nike']);
    await run(process.execPath, ['apps/mcp-server/dist/main.js']);
  } else if (mode === 'migrate') await run(process.execPath, ['packages/db/dist/cli.js', ...args]);
  else if (mode === 'ingest') await run(process.execPath, ['apps/ingest-cli/dist/index.js', ...args]);
  else if (mode === 'mcp') await run(process.execPath, ['apps/mcp-server/dist/main.js', ...args]);
  else throw new Error('Usage: run.mjs demo|migrate|ingest|mcp');
} catch (error) { console.error(error.message); process.exitCode = 1; }
