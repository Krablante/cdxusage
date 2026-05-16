import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
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

const offsetTimestampHome = path.join(root, 'offset-timestamp-codex-home');
const offsetTimestampSessions = path.join(offsetTimestampHome, 'sessions/2026/05/16');
await mkdir(offsetTimestampSessions, { recursive: true });
await writeFile(
  path.join(offsetTimestampSessions, 'offset-timestamp.jsonl'),
  [
    JSON.stringify({ timestamp: '2026-05-17T00:30:00+02:00', type: 'turn_context', payload: { model: 'gpt-test' } }),
    JSON.stringify({
      timestamp: '2026-05-17T00:30:00+02:00',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, total_tokens: 2 } },
      },
    }),
    JSON.stringify({
      timestamp: '2026-05-16T23:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, total_tokens: 3 } },
      },
    }),
    '',
  ].join('\n'),
);
const offsetTimestampReport = await collectUsage({
  codexHome: offsetTimestampHome,
  cacheFile: path.join(root, 'offset-timestamp-cache.json'),
  timezone: 'UTC',
  pricingData,
});
assert.deepEqual(offsetTimestampReport.daily.map((row) => row.key), ['2026-05-16']);
assert.equal(offsetTimestampReport.sessions[0].lastActivity, '2026-05-16T23:00:00.000Z');

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

const resumedHome = path.join(root, 'resumed-codex-home');
const resumedSessions = path.join(resumedHome, 'sessions/2026/05/01');
await mkdir(resumedSessions, { recursive: true });
await writeFile(
  path.join(resumedSessions, 'resumed-session.jsonl'),
  [
    JSON.stringify({ timestamp: '2026-05-01T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-test' } }),
    JSON.stringify({
      timestamp: '2026-05-16T12:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 4, cached_input_tokens: 0, output_tokens: 1, total_tokens: 5 } },
      },
    }),
    '',
  ].join('\n'),
);
const resumedReport = await collectUsage({
  codexHome: resumedHome,
  cacheFile: path.join(root, 'resumed-cache.json'),
  timezone: 'UTC',
  since: '2026-05-16',
  pricingData,
});
assert.equal(resumedReport.totals.totalTokens, 5);
assert.equal(resumedReport.stats.filesSkippedByPathDate, 0);

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

const blockedCacheHome = path.join(root, 'blocked-cache-codex-home');
const blockedCacheSessions = path.join(blockedCacheHome, 'sessions/2026/05/16');
await mkdir(blockedCacheSessions, { recursive: true });
await writeFile(
  path.join(blockedCacheSessions, 'blocked-cache.jsonl'),
  [
    JSON.stringify({ timestamp: '2026-05-16T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-test' } }),
    JSON.stringify({
      timestamp: '2026-05-16T00:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2, total_tokens: 5 } },
      },
    }),
    '',
  ].join('\n'),
);
const cachePathBlocker = path.join(root, 'cache-path-blocker');
await writeFile(cachePathBlocker, 'not a directory');
const blockedCacheReport = await collectUsage({
  codexHome: blockedCacheHome,
  cacheFile: path.join(cachePathBlocker, 'index.json'),
  timezone: 'UTC',
  includePricing: false,
});
assert.equal(blockedCacheReport.totals.totalTokens, 5);
assert.equal(blockedCacheReport.stats.cacheSaveSkippedByError, true);
assert.match(blockedCacheReport.stats.cacheSaveError, /EEXIST|ENOTDIR|not a directory/i);
assert.equal(blockedCacheReport.stats.cacheEntriesSaved, 0);
assert.equal(blockedCacheReport.stats.cacheFile, null);

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

const lineStatsHome = path.join(root, 'line-stats-codex-home');
const lineStatsSessions = path.join(lineStatsHome, 'sessions/2026/05/16');
const lineStatsFile = path.join(lineStatsSessions, 'line-stats.jsonl');
const lineStatsCache = path.join(root, 'line-stats-cache.json');
await mkdir(lineStatsSessions, { recursive: true });
await writeFile(
  lineStatsFile,
  [
    JSON.stringify({ timestamp: '2026-05-16T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-test' } }),
    JSON.stringify({ timestamp: '2026-05-16T00:00:01.000Z', type: 'event_msg', payload: { type: 'non_token' } }),
    JSON.stringify({
      timestamp: '2026-05-16T00:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, total_tokens: 3 } },
      },
    }),
    '',
  ].join('\n'),
);
const lineStatsCold = await collectUsage({
  codexHome: lineStatsHome,
  cacheFile: lineStatsCache,
  timezone: 'UTC',
  pricingData,
});
assert.equal(lineStatsCold.totals.totalTokens, 3);
assert.equal(lineStatsCold.stats.linesSeen, 3);
assert.equal(lineStatsCold.stats.candidateLinesSeen, 2);
await appendFile(
  lineStatsFile,
  [
    JSON.stringify({ timestamp: '2026-05-16T00:00:03.000Z', type: 'event_msg', payload: { type: 'non_token' } }),
    JSON.stringify({
      timestamp: '2026-05-16T00:00:04.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, total_tokens: 2 } },
      },
    }),
    '',
  ].join('\n'),
);
const lineStatsTail = await collectUsage({
  codexHome: lineStatsHome,
  cacheFile: lineStatsCache,
  timezone: 'UTC',
  pricingData,
});
assert.equal(lineStatsTail.totals.totalTokens, 5);
assert.equal(lineStatsTail.stats.filesScannedTail, 1);
assert.equal(lineStatsTail.stats.linesSeen, 2);
assert.equal(lineStatsTail.stats.candidateLinesSeen, 1);

const noFinalNewlineHome = path.join(root, 'no-final-newline-codex-home');
const noFinalNewlineSessions = path.join(noFinalNewlineHome, 'sessions/2026/05/16');
const noFinalNewlineFile = path.join(noFinalNewlineSessions, 'no-final-newline.jsonl');
const noFinalNewlineCache = path.join(root, 'no-final-newline-cache.json');
await mkdir(noFinalNewlineSessions, { recursive: true });
await writeFile(
  noFinalNewlineFile,
  [
    JSON.stringify({ timestamp: '2026-05-16T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-test' } }),
    JSON.stringify({
      timestamp: '2026-05-16T00:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, total_tokens: 3 } },
      },
    }),
  ].join('\n'),
);
const noFinalNewline = await collectUsage({
  codexHome: noFinalNewlineHome,
  cacheFile: noFinalNewlineCache,
  timezone: 'UTC',
  pricingData,
});
const noFinalNewlineCachePayload = JSON.parse(await readFile(noFinalNewlineCache, 'utf8'));
assert.equal(noFinalNewline.totals.totalTokens, 3);
assert.equal(noFinalNewline.stats.linesSeen, 2);
assert.equal(noFinalNewlineCachePayload.files[noFinalNewlineFile].endedWithNewline, false);

const nativeFallbackHome = path.join(root, 'native-fallback-codex-home');
const nativeFallbackSessions = path.join(nativeFallbackHome, 'sessions/2026/05/16');
await mkdir(nativeFallbackSessions, { recursive: true });
await writeFile(
  path.join(nativeFallbackSessions, 'native-fallback.jsonl'),
  [
    JSON.stringify({ timestamp: '2026-05-16T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-test' } }),
    JSON.stringify({ timestamp: '2026-05-16T00:00:01.000Z', type: 'event_msg', payload: { type: 'non_token' } }),
    JSON.stringify({
      timestamp: '2026-05-16T00:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 2, total_tokens: 5 } },
      },
    }),
    '',
  ].join('\n'),
);
const previousScanMode = process.env.CDXUSAGE_SCAN_MODE;
const previousForceNativeFail = process.env.CDXUSAGE_FORCE_NATIVE_BATCH_FAIL;
process.env.CDXUSAGE_SCAN_MODE = 'grep-batch';
process.env.CDXUSAGE_FORCE_NATIVE_BATCH_FAIL = '1';
try {
  const nativeFallback = await collectUsage({
    codexHome: nativeFallbackHome,
    cacheFile: path.join(root, 'native-fallback-cache.json'),
    timezone: 'UTC',
    pricingData,
  });
  assert.equal(nativeFallback.totals.totalTokens, 5);
  assert.equal(nativeFallback.stats.nativeBatchFallback, true);
  assert.equal(nativeFallback.stats.linesSeen, 3);
  assert.equal(nativeFallback.stats.candidateLinesSeen, 2);
  assert.equal(nativeFallback.stats.scannerModes.needle, 1);
} finally {
  if (previousScanMode == null) {
    delete process.env.CDXUSAGE_SCAN_MODE;
  } else {
    process.env.CDXUSAGE_SCAN_MODE = previousScanMode;
  }
  if (previousForceNativeFail == null) {
    delete process.env.CDXUSAGE_FORCE_NATIVE_BATCH_FAIL;
  } else {
    process.env.CDXUSAGE_FORCE_NATIVE_BATCH_FAIL = previousForceNativeFail;
  }
}

const nativeEarlyExitHome = path.join(root, 'native-early-exit-codex-home');
const nativeEarlyExitSessions = path.join(nativeEarlyExitHome, 'sessions/2026/05/16');
const nativeEarlyExitCache = path.join(root, 'native-early-exit-cache.json');
await mkdir(nativeEarlyExitSessions, { recursive: true });
for (let i = 0; i < 3000; i += 1) {
  await writeFile(
    path.join(nativeEarlyExitSessions, `native-early-exit-${i}.jsonl`),
    [
      JSON.stringify({ timestamp: '2026-05-16T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-test' } }),
      JSON.stringify({
        timestamp: '2026-05-16T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, total_tokens: 2 } },
        },
      }),
      '',
    ].join('\n'),
  );
}
const fakeBin = path.join(root, 'fake-native-bin');
await mkdir(fakeBin, { recursive: true });
if (process.platform === 'win32') {
  await writeFile(path.join(fakeBin, 'xargs.cmd'), '@echo off\r\nexit /b 1\r\n');
} else {
  await writeFile(path.join(fakeBin, 'xargs'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
}
const previousPath = process.env.PATH;
process.env.CDXUSAGE_SCAN_MODE = 'grep-batch';
process.env.PATH = fakeBin;
try {
  const nativeEarlyExit = await collectUsage({
    codexHome: nativeEarlyExitHome,
    cacheFile: nativeEarlyExitCache,
    timezone: 'UTC',
    includePricing: false,
  });
  assert.equal(nativeEarlyExit.totals.totalTokens, 6000);
  assert.equal(nativeEarlyExit.stats.nativeBatchFallback, true);
  assert.equal(nativeEarlyExit.stats.filesScannedFull, 3000);
  assert.equal(nativeEarlyExit.stats.scannerModes.needle, 3000);
} finally {
  if (previousScanMode == null) {
    delete process.env.CDXUSAGE_SCAN_MODE;
  } else {
    process.env.CDXUSAGE_SCAN_MODE = previousScanMode;
  }
  if (previousPath == null) {
    delete process.env.PATH;
  } else {
    process.env.PATH = previousPath;
  }
}

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
if (process.platform === 'linux') {
  const symlinkReport = await collectUsage({
    codexHome: symlinkHome,
    cacheFile: path.join(root, 'symlink-cache.json'),
    timezone: 'UTC',
    discoveryMode: 'find',
    pricingData,
  });
  assert.equal(symlinkReport.totals.totalTokens, 0);
  assert.equal(symlinkReport.stats.filesSeen, 0);
}
const symlinkNodeReport = await collectUsage({
  codexHome: symlinkHome,
  cacheFile: path.join(root, 'symlink-node-cache.json'),
  timezone: 'UTC',
  discoveryMode: 'node',
  pricingData,
});
assert.equal(symlinkNodeReport.totals.totalTokens, 0);
assert.equal(symlinkNodeReport.stats.filesSeen, 0);

await rm(root, { recursive: true, force: true });
console.log('engine ok');

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}
