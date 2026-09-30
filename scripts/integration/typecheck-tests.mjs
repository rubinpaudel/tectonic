import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const location of ['packages/core', 'packages/db', 'packages/ingestion', 'packages/memory', 'apps/ingest-cli', 'apps/mcp-server']) {
  const config = `${location}/tsconfig.test.json`;
  if (!existsSync(config)) continue;
  const result = spawnSync('pnpm', ['--config.verify-deps-before-run=false', 'exec', 'tsc', '--project', config], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
