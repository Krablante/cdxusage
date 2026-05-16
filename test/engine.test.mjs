import assert from 'node:assert/strict';
import { appendFile, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectUsage, normalizeDate } from '../src/engine.mjs';

const root = path.join(tmpdir(), `cdxusage-engine-${process.pid}`);
const codexHome = path.join(root, 'codex-home');
const cacheFile = path.join(root, 'cache/index.json');
const sessionsDir = path.join(codexHome, 'sessions/2026/05/16');
const fileA = path.join(sessionsDir, 'rollout-2026-05-16T00-00-00-test-a.jsonl');
const pricingData = {
  'gpt-test': {
    inputCostPerMToken: 1,
    cachedInputCostPerMToken: 0.1,
    outputCostPerMToken: 2,
  },
  'gpt-5': {
    inputCostPerMToken: 2,
    cachedInputCostPerMToken: 0.2,
    outputCostPerMToken: 3,
  },
};

await rm(root, { recursive: true, force: true });
await mkdir(sessionsDir, { recursive: true });
await writeFile(
  fileA,
  [
    JSON.stringify({ timestamp: '2026-05-16T23:50:00.000Z', type: 'turn_context', payload: { model: 'gpt-test' } }),
    JSON.stringify({
      timestamp: '2026-05-16T23:55:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 4,
            output_tokens: 2,
            reasoning_output_tokens: 1,
            total_tokens: 12,
          },
          total_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 4,
            output_tokens: 2,
            reasoning_output_tokens: 1,
            total_tokens: 12,
          },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-05-17T00:05:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 20,
            cached_input_tokens: 7,
            output_tokens: 5,
            reasoning_output_tokens: 2,
            total_tokens: 25,
          },
        },
      },
    }),
    '',
  ].join('\n'),
);

const cold = await collectUsage({
  codexHome,
  cacheFile,
  clearCache: true,
  timezone: 'UTC',
  pricingData,
});
assert.equal(cold.daily.length, 2);
assert.equal(cold.monthly.length, 1);
assert.equal(cold.sessions.length, 1);
assert.equal(cold.totals.inputTokens, 20);
assert.equal(cold.totals.cachedInputTokens, 7);
assert.equal(cold.totals.outputTokens, 5);
assert.equal(cold.totals.totalTokens, 25);
assert.equal(cold.sessions[0].lastActivity, '2026-05-17T00:05:00.000Z');
assert.equal(cold.stats.filesScannedFull, 1);
assertClose(cold.totals.costUSD, 0.0000237);

const warm = await collectUsage({ codexHome, cacheFile, timezone: 'UTC', pricingData });
assert.deepEqual(warm.totals, cold.totals);
assert.equal(warm.stats.filesFromCache, 1);
assert.equal(warm.stats.bytesRead, 0);

await appendFile(
  fileA,
  `${JSON.stringify({
    timestamp: '2026-05-17T00:10:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 7,
          cached_input_tokens: 1,
          output_tokens: 1,
          reasoning_output_tokens: 0,
          total_tokens: 8,
        },
      },
    },
  })}\n`,
);
const tail = await collectUsage({ codexHome, cacheFile, timezone: 'UTC', pricingData });
assert.equal(tail.totals.totalTokens, 33);
assert.equal(tail.stats.filesScannedTail, 1);

const filtered = await collectUsage({ codexHome, cacheFile, timezone: 'UTC', since: '2026-05-17', pricingData });
assert.equal(filtered.daily.length, 1);
assert.equal(filtered.sessions[0].totalTokens, 21);
assert.equal(filtered.totals.totalTokens, 21);

const defaultTimezoneHome = path.join(root, 'default-timezone-codex-home');
const defaultTimezoneSessions = path.join(defaultTimezoneHome, 'sessions/2026/05/16');
await mkdir(defaultTimezoneSessions, { recursive: true });
await writeFile(
  path.join(defaultTimezoneSessions, 'utc-boundary.jsonl'),
  [
    JSON.stringify({ timestamp: '2026-05-16T02:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-test' } }),
    JSON.stringify({
      timestamp: '2026-05-16T02:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, total_tokens: 2 } },
      },
    }),
    '',
  ].join('\n'),
);
const defaultTimezoneReport = await collectUsage({
  codexHome: defaultTimezoneHome,
  cacheFile: path.join(root, 'default-timezone-cache.json'),
  pricingData,
});
assert.equal(defaultTimezoneReport.stats.timezone, 'UTC');
assert.equal(defaultTimezoneReport.daily[0].key, '2026-05-16');
const losAngelesReport = await collectUsage({
  codexHome: defaultTimezoneHome,
  cacheFile: path.join(root, 'default-timezone-cache-la.json'),
  timezone: 'America/Los_Angeles',
  pricingData,
});
assert.equal(losAngelesReport.daily[0].key, '2026-05-15');

const staleMtimeHome = path.join(root, 'stale-mtime-codex-home');
const staleMtimeSessions = path.join(staleMtimeHome, 'sessions/2026/05/16');
const staleMtimeFile = path.join(staleMtimeSessions, 'stale-mtime.jsonl');
await mkdir(staleMtimeSessions, { recursive: true });
await writeFile(
  staleMtimeFile,
  [
    JSON.stringify({ timestamp: '2026-05-16T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-test' } }),
    JSON.stringify({
      timestamp: '2026-05-16T00:01:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1, total_tokens: 6 } },
      },
    }),
    '',
  ].join('\n'),
);
await utimes(staleMtimeFile, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));
const staleMtimeReport = await collectUsage({
  codexHome: staleMtimeHome,
  cacheFile: path.join(root, 'stale-mtime-cache.json'),
  timezone: 'UTC',
  since: '2026-05-16',
  pricingData,
});
assert.equal(staleMtimeReport.totals.totalTokens, 6);
assert.equal(staleMtimeReport.stats.filesSkippedByMtime, 0);

await writeFile(cacheFile, 'x'.repeat(1024 * 1024 + 1));
const oversizedCache = await collectUsage({ codexHome, cacheFile, timezone: 'UTC', pricingData, maxCacheBytes: 1024 * 1024 });
assert.equal(oversizedCache.stats.cacheLoadSkippedBySize, true);
assert.equal(oversizedCache.stats.filesScannedFull, 1);

const saveCapHome = path.join(root, 'save-cap-codex-home');
const saveCapSessions = path.join(saveCapHome, 'sessions/2026/05/16');
await mkdir(saveCapSessions, { recursive: true });
const saveCapLines = [JSON.stringify({ timestamp: '2026-05-16T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-save-cap-0' } })];
for (let i = 0; i < 3500; i += 1) {
  saveCapLines.push(JSON.stringify({ timestamp: '2026-05-16T00:00:00.000Z', type: 'turn_context', payload: { model: `gpt-save-cap-${i}` } }));
  saveCapLines.push(
    JSON.stringify({
      timestamp: '2026-05-16T00:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, total_tokens: 2 } },
      },
    }),
  );
}
saveCapLines.push('');
const saveCapCache = path.join(root, 'save-cap-cache/index.json');
await writeFile(path.join(saveCapSessions, 'fat-cache.jsonl'), saveCapLines.join('\n'));
const saveCap = await collectUsage({
  codexHome: saveCapHome,
  cacheFile: saveCapCache,
  timezone: 'UTC',
  includePricing: false,
  maxCacheBytes: 1024 * 1024,
});
assert.equal(saveCap.stats.cacheSaveSkippedBySize, true);
assert.equal(saveCap.stats.cacheEntriesSaved, 0);
assert.equal(saveCap.totals.totalTokens, 7000);

assert.throws(() => normalizeDate('2026-02-30'), /Invalid date/);
assert.throws(() => normalizeDate('2026-99-99'), /Invalid date/);

const mixedHome = path.join(root, 'mixed-codex-home');
const mixedSessionsDir = path.join(mixedHome, 'sessions/2026/05/16');
await mkdir(mixedSessionsDir, { recursive: true });
await writeFile(
  path.join(mixedSessionsDir, 'mixed.jsonl'),
  [
    JSON.stringify({ timestamp: '2026-05-16T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-test' } }),
    JSON.stringify({
      timestamp: '2026-05-16T00:01:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 5,
            cached_input_tokens: 3,
            output_tokens: 1,
            reasoning_output_tokens: 0,
            total_tokens: 6,
          },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-05-16T00:02:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 15,
            cached_input_tokens: 8,
            output_tokens: 4,
            reasoning_output_tokens: 0,
            total_tokens: 19,
          },
        },
      },
    }),
    '',
  ].join('\n'),
);
const mixed = await collectUsage({
  codexHome: mixedHome,
  cacheFile: path.join(root, 'mixed-cache.json'),
  timezone: 'UTC',
  pricingData,
});
assert.equal(mixed.totals.inputTokens, 15);
assert.equal(mixed.totals.cachedInputTokens, 8);
assert.equal(mixed.totals.outputTokens, 4);
assert.equal(mixed.totals.totalTokens, 19);

const tieredHome = path.join(root, 'tiered-codex-home');
const tieredSessionsDir = path.join(tieredHome, 'sessions/2026/05/16');
const tieredCache = path.join(root, 'tiered-cache.json');
const tieredPricingData = {
  'gpt-tier-engine': {
    input_cost_per_token: 0.000001,
    cache_read_input_token_cost: 0,
    output_cost_per_token: 0,
    input_cost_per_token_above_10k_tokens: 0.000003,
  },
};
await mkdir(tieredSessionsDir, { recursive: true });
await writeFile(
  path.join(tieredSessionsDir, 'tiered.jsonl'),
  [
    JSON.stringify({ timestamp: '2026-05-16T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-tier-engine' } }),
    JSON.stringify({
      timestamp: '2026-05-16T00:01:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 20_000, cached_input_tokens: 0, output_tokens: 0, total_tokens: 20_000 } },
      },
    }),
    '',
  ].join('\n'),
);
const tieredCold = await collectUsage({
  codexHome: tieredHome,
  cacheFile: tieredCache,
  timezone: 'UTC',
  pricingData: tieredPricingData,
});
assert.equal(tieredCold.stats.billingThresholds.includes(10_000), true);
assertClose(tieredCold.totals.costUSD, 0.06);
const tieredWarm = await collectUsage({
  codexHome: tieredHome,
  cacheFile: tieredCache,
  timezone: 'UTC',
  pricingData: tieredPricingData,
});
assert.equal(tieredWarm.stats.filesFromCache, 1);
assertClose(tieredWarm.totals.costUSD, 0.06);

const symlinkHome = path.join(root, 'symlink-codex-home');
const symlinkSessions = path.join(symlinkHome, 'sessions');
const symlinkTargets = path.join(root, 'symlink-targets');
const symlinkDirTarget = path.join(root, 'symlink-dir-target');
await mkdir(symlinkSessions, { recursive: true });
await mkdir(symlinkTargets, { recursive: true });
await mkdir(symlinkDirTarget, { recursive: true });
await writeFile(
  path.join(symlinkTargets, 'linked.jsonl'),
  [
    JSON.stringify({ timestamp: '2026-05-16T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-test' } }),
    JSON.stringify({
      timestamp: '2026-05-16T00:01:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, total_tokens: 2 } },
      },
    }),
    '',
  ].join('\n'),
);
await writeFile(
  path.join(symlinkDirTarget, 'outside.jsonl'),
  [
    JSON.stringify({ timestamp: '2026-05-16T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-test' } }),
    JSON.stringify({
      timestamp: '2026-05-16T00:01:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 100, total_tokens: 200 } },
      },
    }),
    '',
  ].join('\n'),
);
await symlink(path.join(symlinkTargets, 'linked.jsonl'), path.join(symlinkSessions, 'linked.jsonl'));
await symlink(symlinkDirTarget, path.join(symlinkSessions, 'linked-dir'), 'dir');
const symlinkReport = await collectUsage({
  codexHome: symlinkHome,
  cacheFile: path.join(root, 'symlink-cache.json'),
  timezone: 'UTC',
  discoveryMode: 'find',
  pricingData,
});
assert.equal(symlinkReport.totals.totalTokens, 2);
assert.equal(symlinkReport.stats.filesSeen, 1);

await rm(root, { recursive: true, force: true });
console.log('engine ok');

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}
