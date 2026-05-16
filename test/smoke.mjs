import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(tmpdir(), 'cdxusage-smoke-'));

try {
  const codexHome = path.join(root, 'codex-home');
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '05', '16');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(path.join(codexHome, 'config.toml'), 'service_tier = "fast"\n');
  await writeFile(
    path.join(sessionsDir, 'session-2026-05-16T00-00-00.jsonl'),
    [
      JSON.stringify({
        timestamp: '2026-05-16T00:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'turn_context', model: 'gpt-5.4-mini' },
      }),
      JSON.stringify({
        timestamp: '2026-05-16T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 400,
              output_tokens: 100,
              reasoning_output_tokens: 20,
              total_tokens: 1100,
            },
          },
        },
      }),
      '',
    ].join('\n'),
  );

  const isPortable = process.argv.includes('--portable');
  const command = isPortable ? path.join(repoRoot, 'portable', 'cdxusage') : process.execPath;
  const args = isPortable
    ? ['monthly', '--codex-home', codexHome, '--offline', '--json', '--include-stats', '--cache-file', path.join(root, 'index.json'), '--pricing-cache-file', path.join(root, 'pricing.json')]
    : [path.join(repoRoot, 'bin', 'cdxusage.mjs'), 'monthly', '--codex-home', codexHome, '--offline', '--json', '--include-stats', '--cache-file', path.join(root, 'index.json'), '--pricing-cache-file', path.join(root, 'pricing.json')];
  const result = spawnSync(command, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.monthly.length, 1);
  assert.equal(payload.pricing.tier, 'priority');
  assert.equal(payload.pricing.priorityModels, null);
  assert.equal(payload.pricing.missingModels.length, 0);
  assert.equal(payload.stats.codexHome, codexHome);
  console.log('smoke ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
