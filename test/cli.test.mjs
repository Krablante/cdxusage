import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, parseArgs } from '../src/cli.mjs';

const root = path.join(tmpdir(), `cdxusage-cli-${process.pid}`);
const codexHome = path.join(root, 'codex-home');
const sessionsDir = path.join(codexHome, 'sessions/2026/05/16');
const file = path.join(sessionsDir, 'rollout-2026-05-16T00-00-00-compat.jsonl');
const cacheFile = path.join(root, 'cache/index.json');
const pricingCacheFile = path.join(root, 'cache/pricing.json');

await rm(root, { recursive: true, force: true });
await mkdir(sessionsDir, { recursive: true });
await writeFile(path.join(codexHome, 'config.toml'), 'service_tier = "fast"\n');
await writeFile(
  file,
  [
    JSON.stringify({ timestamp: '2026-05-16T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5' } }),
    JSON.stringify({
      timestamp: '2026-05-16T00:01:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 200,
            output_tokens: 100,
            reasoning_output_tokens: 40,
            total_tokens: 1100,
          },
        },
      },
    }),
    '',
  ].join('\n'),
);

assert.equal(parseArgs(['monthly', '--json']).command, 'monthly');
assert.equal(parseArgs(['sessions']).command, 'sessions');
assert.equal(parseArgs(['--json', 'daily']).command, 'daily');
assert.equal(parseArgs(['--offline', 'monthly']).command, 'monthly');
assert.equal(parseArgs(['--version', 'daily']).command, 'daily');
assert.equal(parseArgs(['--help', 'daily']).command, 'daily');
assert.throws(() => parseArgs(['daily', 'monthly']), /Unknown command or argument/);
assert.equal(parseArgs(['monthly']).speed, 'auto');
assert.equal(parseArgs(['daily', '--speed', 'auto']).speed, 'auto');
assert.equal(parseArgs(['daily', '--speed', 'fast']).speed, 'fast');
assert.equal(parseArgs(['daily', '--speed=fast']).speed, 'fast');
assert.equal(parseArgs(['daily', '--no-priority']).speed, 'standard');
assert.equal(parseArgs(['daily', '--priority-models', 'gpt-5.4,gpt-5.5']).priorityModels, 'gpt-5.4,gpt-5.5');
assert.equal(parseArgs(['daily', '--priority-models=gpt-5.4,gpt-5.5']).priorityModels, 'gpt-5.4,gpt-5.5');
assert.deepEqual(
  { sort: parseArgs(['daily', '--sort', 'tokens', '--order', 'desc']).sort, order: parseArgs(['daily', '--sort', 'tokens', '--order', 'desc']).order },
  { sort: 'tokens', order: 'desc' },
);
assert.deepEqual(
  {
    since: parseArgs(['daily', '--since=2026-05-16']).since,
    until: parseArgs(['daily', '--until=2026-05-17']).until,
    timezone: parseArgs(['daily', '--timezone=UTC']).timezone,
    cacheFile: parseArgs(['daily', '--cache-file=/tmp/cdxusage-cache.json']).cacheFile,
  },
  {
    since: '2026-05-16',
    until: '2026-05-17',
    timezone: 'UTC',
    cacheFile: path.resolve('/tmp/cdxusage-cache.json'),
  },
);
assert.equal(parseArgs(['daily', '--max-cache-bytes', '1048576']).maxCacheBytes, '1048576');
assert.throws(() => parseArgs(['daily', '--discovery', 'bogus']), /Invalid --discovery/);
assert.throws(() => parseArgs(['daily', '--pricing-ttl-hours', 'nope']), /Invalid --pricing-ttl-hours/);
assert.throws(() => parseArgs(['daily', '--pricing-fetch-timeout-ms', '0']), /Invalid --pricing-fetch-timeout-ms/);
assert.throws(() => parseArgs(['daily', '--max-cache-bytes', 'nope']), /Invalid --max-cache-bytes/);
assert.throws(() => parseArgs(['daily', '--speed', 'warp']), /Invalid --speed/);

const daily = await runCli([
  'daily',
  '--json',
  '--offline',
  '--codex-home',
  codexHome,
  '--cache-file',
  cacheFile,
  '--pricing-cache-file',
  pricingCacheFile,
]);
assert.equal(daily.code, 0);
const parsed = JSON.parse(daily.stdout);
assert.equal(parsed.daily[0].date, 'May 16, 2026');
assert.equal(parsed.daily[0].dateKey, '2026-05-16');
assert.equal(parsed.daily[0].inputTokens, 1000);
assert.equal(parsed.daily[0].models['gpt-5'].isFallback, false);
assert.equal(parsed.totals.totalTokens, 1100);

const session = await runCli([
  'session',
  '--json',
  '--offline',
  '--codex-home',
  codexHome,
  '--cache-file',
  cacheFile,
  '--pricing-cache-file',
  pricingCacheFile,
]);
const sessionJson = JSON.parse(session.stdout);
assert.equal(sessionJson.sessions[0].sessionId, '2026/05/16/rollout-2026-05-16T00-00-00-compat');
assert.equal(sessionJson.sessions[0].directory, '2026/05/16');

const table = await runCli([
  'monthly',
  '--offline',
  '--noColor',
  '--codex-home',
  codexHome,
  '--cache-file',
  cacheFile,
  '--pricing-cache-file',
  pricingCacheFile,
]);
assert.match(table.stdout, /Codex Token Usage Report - Monthly/);
assert.match(table.stdout, /Total Tokens/);
assert.match(table.stdout, /\$0\.004050/);
assert.doesNotMatch(table.stdout, /├[^\n]+\n├/);

const fastPricing = await runCli([
  'daily',
  '--json',
  '--offline',
  '--speed',
  'fast',
  '--codex-home',
  codexHome,
  '--cache-file',
  cacheFile,
  '--pricing-cache-file',
  path.join(root, 'cache/fast-pricing.json'),
]);
assert.equal(JSON.parse(fastPricing.stdout).totals.costUSD, 0.00405);

const autoPricing = await runCli([
  'daily',
  '--json',
  '--offline',
  '--speed',
  'auto',
  '--codex-home',
  codexHome,
  '--cache-file',
  cacheFile,
  '--pricing-cache-file',
  path.join(root, 'cache/auto-pricing.json'),
]);
assert.equal(JSON.parse(autoPricing.stdout).totals.costUSD, 0.00405);

const autoAllPricing = await runCli([
  'daily',
  '--json',
  '--offline',
  '--speed',
  'auto',
  '--priority-models',
  'all',
  '--codex-home',
  codexHome,
  '--cache-file',
  cacheFile,
  '--pricing-cache-file',
  path.join(root, 'cache/auto-all-pricing.json'),
]);
assert.equal(JSON.parse(autoAllPricing.stdout).totals.costUSD, 0.00405);

const noPricing = await runCli([
  'daily',
  '--json',
  '--no-pricing',
  '--include-stats',
  '--codex-home',
  codexHome,
  '--cache-file',
  cacheFile,
  '--pricing-cache-file',
  pricingCacheFile,
]);
const noPricingJson = JSON.parse(noPricing.stdout);
assert.equal(noPricingJson.daily[0].costUSD, null);
assert.equal(noPricingJson.totals.costUSD, null);
assert.deepEqual(noPricingJson.pricing, { enabled: false, estimated: false, skipped: true });

const noPricingTable = await runCli([
  'daily',
  '--no-pricing',
  '--noColor',
  '--codex-home',
  codexHome,
  '--cache-file',
  cacheFile,
  '--pricing-cache-file',
  pricingCacheFile,
]);
assert.match(noPricingTable.stdout, /n\/a/);

const priorityCodexHome = path.join(root, 'priority-codex-home');
const prioritySessionsDir = path.join(priorityCodexHome, 'sessions/2026/05/16');
const priorityCacheFile = path.join(root, 'cache/priority-index.json');
await mkdir(prioritySessionsDir, { recursive: true });
await writeFile(path.join(priorityCodexHome, 'config.toml'), 'service_tier = "fast"\n');
await writeFile(
  path.join(prioritySessionsDir, 'priority-2026-05-16T00-00-00.jsonl'),
  [
    JSON.stringify({ timestamp: '2026-05-16T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.5' } }),
    JSON.stringify({
      timestamp: '2026-05-16T00:01:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 200,
            output_tokens: 100,
            total_tokens: 1100,
          },
        },
      },
    }),
    '',
  ].join('\n'),
);
const autoDefaultPricing = await runCli([
  'daily',
  '--json',
  '--offline',
  '--codex-home',
  priorityCodexHome,
  '--cache-file',
  priorityCacheFile,
  '--pricing-cache-file',
  path.join(root, 'cache/priority-auto-default.json'),
]);
const standardAliasPricing = await runCli([
  'daily',
  '--json',
  '--offline',
  '--no-priority',
  '--codex-home',
  priorityCodexHome,
  '--cache-file',
  priorityCacheFile,
  '--pricing-cache-file',
  path.join(root, 'cache/priority-standard-alias.json'),
]);
assert.equal(JSON.parse(autoDefaultPricing.stdout).totals.costUSD, 0.01775);
assert.equal(JSON.parse(standardAliasPricing.stdout).totals.costUSD, 0.0071);

const previousCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = priorityCodexHome;
try {
  const envDiscoveredPricing = await runCli([
    'daily',
    '--json',
    '--offline',
    '--include-stats',
    '--cache-file',
    path.join(root, 'cache/env-discovered-index.json'),
    '--pricing-cache-file',
    path.join(root, 'cache/env-discovered-pricing.json'),
  ]);
  const envDiscoveredJson = JSON.parse(envDiscoveredPricing.stdout);
  assert.equal(envDiscoveredJson.totals.costUSD, 0.01775);
  assert.equal(envDiscoveredJson.stats.codexHome, priorityCodexHome);
  assert.equal(envDiscoveredJson.stats.codexHomeSource, 'CODEX_HOME');
} finally {
  if (previousCodexHome == null) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = previousCodexHome;
  }
}

const sorted = await runCli([
  'daily',
  '--json',
  '--offline',
  '--sort',
  'tokens',
  '--order',
  'desc',
  '--codex-home',
  codexHome,
  '--cache-file',
  cacheFile,
  '--pricing-cache-file',
  pricingCacheFile,
]);
assert.equal(JSON.parse(sorted.stdout).daily[0].totalTokens, 1100);

const noCache = await runCli([
  'daily',
  '--json',
  '--offline',
  '--no-cache',
  '--include-stats',
  '--codex-home',
  codexHome,
  '--cache-file',
  path.join(root, 'cache/no-cache.json'),
  '--pricing-cache-file',
  pricingCacheFile,
]);
const noCacheJson = JSON.parse(noCache.stdout);
assert.equal(noCacheJson.stats.cacheEntriesSaved, 0);
assert.equal(noCacheJson.stats.cacheFile, null);

const previousPath = process.env.PATH;
const previousScanMode = process.env.CDXUSAGE_SCAN_MODE;
const missingFindBin = path.join(root, 'missing-find-bin');
await mkdir(missingFindBin, { recursive: true });
process.env.PATH = missingFindBin;
process.env.CDXUSAGE_SCAN_MODE = 'node';
try {
  const missingFindAuto = await runCli([
    'daily',
    '--json',
    '--offline',
    '--no-pricing',
    '--include-stats',
    '--discovery',
    'auto',
    '--codex-home',
    codexHome,
    '--cache-file',
    path.join(root, 'cache/missing-find-auto.json'),
    '--pricing-cache-file',
    pricingCacheFile,
  ]);
  assert.equal(missingFindAuto.code, 0);
  assert.equal(missingFindAuto.stderr, '');
  assert.match(JSON.parse(missingFindAuto.stdout).stats.discoveryMode, /^node-fallback:/);

  const missingFindForced = await runCli([
    'daily',
    '--json',
    '--offline',
    '--no-pricing',
    '--discovery',
    'find',
    '--codex-home',
    codexHome,
    '--cache-file',
    path.join(root, 'cache/missing-find-forced.json'),
    '--pricing-cache-file',
    pricingCacheFile,
  ]);
  assert.equal(missingFindForced.code, 1);
  assert.match(missingFindForced.stderr, /find discovery is unavailable: spawn find ENOENT/);
  assert.doesNotMatch(missingFindForced.stderr, /node:internal|ErrorCaptureStackTrace/);
} finally {
  if (previousPath == null) {
    delete process.env.PATH;
  } else {
    process.env.PATH = previousPath;
  }
  if (previousScanMode == null) {
    delete process.env.CDXUSAGE_SCAN_MODE;
  } else {
    process.env.CDXUSAGE_SCAN_MODE = previousScanMode;
  }
}

const badTimezone = await runCli(['daily', '--timezone', 'Not/AZone']);
assert.equal(badTimezone.code, 1);
assert.match(badTimezone.stderr, /Invalid timezone/);

const missingTimezone = await runCli(['daily', '--timezone']);
assert.equal(missingTimezone.code, 1);
assert.match(missingTimezone.stderr, /--timezone requires a value/);

const badSort = await runCli(['daily', '--sort', 'bogus']);
assert.equal(badSort.code, 1);
assert.match(badSort.stderr, /Invalid --sort/);

await rm(root, { recursive: true, force: true });
console.log('cli ok');

async function runCli(args) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  return { code, stdout, stderr };
}
