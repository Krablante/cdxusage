#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const allowedModes = new Set(['node', 'needle', 'line', 'grep', 'grep-batch']);
const mode = process.argv[2];

if (!allowedModes.has(mode)) {
  console.error(`Usage: node ./scripts/run-tests-with-scan-mode.mjs <${[...allowedModes].join('|')}>`);
  process.exit(2);
}

const testFiles = [
  'test/codex-home.test.mjs',
  'test/engine.test.mjs',
  'test/cli.test.mjs',
  'test/pricing.test.mjs',
];

for (const file of testFiles) {
  const result = spawnSync(process.execPath, [path.normalize(file)], {
    env: { ...process.env, CDXUSAGE_SCAN_MODE: mode },
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
