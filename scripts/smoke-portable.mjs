#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portableRoot = path.join(repoRoot, 'portable');

run(process.execPath, [path.join(repoRoot, 'scripts', 'build-portable.mjs')]);

for (const file of [
  'LICENSE',
  'cdxusage.cmd',
  'cdxusage.ps1',
  path.join('src', 'codex-home.mjs'),
]) {
  assert.equal(existsSync(path.join(portableRoot, file)), true, `${file} missing from portable build`);
}

if (process.platform === 'win32') {
  run(path.join(portableRoot, 'cdxusage.cmd'), ['--version'], { shell: true });
  run('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(portableRoot, 'cdxusage.ps1'),
    '--version',
  ]);
} else {
  run(path.join(portableRoot, 'cdxusage'), ['--version']);
}

run(process.execPath, [path.join(repoRoot, 'test', 'smoke.mjs'), '--portable']);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
