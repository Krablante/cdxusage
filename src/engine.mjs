import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import { resolveCodexDataPaths } from './codex-home.mjs';
import { discoverJsonlFiles } from './discovery.mjs';
import { calculateCostFromUsageOrEvents, loadPricingCatalog } from './pricing.mjs';

const CACHE_VERSION = 2;
const CACHE_SOURCE = 'cdxusage-index';
const DEFAULT_BILLING_THRESHOLDS = Object.freeze([128_000, 200_000, 256_000, 272_000]);
const TOKEN_NEEDLE = Buffer.from('token_count');
const TURN_NEEDLE = Buffer.from('turn_context');
const SCAN_NEEDLES = Object.freeze([TOKEN_NEEDLE, TURN_NEEDLE]);
const MODEL_RE = /"model"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/;
const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;
const NATIVE_BATCH_PERL_SCRIPT = `
BEGIN { $current = ""; $lines = 0; }
sub emit_count {
  if ($current ne "") {
    print "C\\0$current\\0$lines\\0";
  }
}
if ($ARGV ne $current) {
  emit_count();
  $current = $ARGV;
  $lines = 0;
}
$lines++;
if (index($_, "token_count") >= 0 || index($_, "turn_context") >= 0) {
  chomp;
  s/\\r\\z//;
  print "L\\0$ARGV\\0$_\\0";
}
END { emit_count(); }
`;
let nativeBatchCapabilityPromise;

export function defaultCacheFile() {
  const root = process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache');
  return path.join(root, 'cdxusage', 'index-v2.json');
}

export async function collectUsage(options = {}) {
  const dataPaths = options.dataPaths ?? (await resolveCodexDataPaths(options));
  const codexHome = dataPaths.codexHome;
  const sessionsDir = dataPaths.sessionsDir;
  const timezone = safeTimeZone(options.timezone);
  const dateKeyer = createDateKeyer(timezone);
  const since = normalizeDate(options.since);
  const until = normalizeDate(options.until);
  const cacheFile = options.cacheFile ?? defaultCacheFile();
  const useCache = options.useCache !== false;
  const saveCache = useCache && options.saveCache !== false;
  const discoveryMode = options.discoveryMode ?? 'auto';
  const maxCacheBytes = normalizeCacheByteLimit(options.maxCacheBytes ?? process.env.CDXUSAGE_MAX_CACHE_BYTES);
  const pricingCatalog =
    options.includePricing !== false
      ? await loadPricingCatalog(pricingCatalogOptions(options))
      : null;
  const billingThresholds = normalizeBillingThresholds(pricingCatalog?.metadata?.billingThresholds);
  const scannerMode = process.env.CDXUSAGE_SCAN_MODE ?? 'auto';

  const loadResult =
    useCache && !options.clearCache
      ? await loadCache(cacheFile, maxCacheBytes)
      : { cache: emptyCache(timezone, billingThresholds) };
  const loadedCache = loadResult.cache;
  const cache =
    loadedCache.timezone === timezone && sameBillingThresholds(loadedCache.billingThresholds, billingThresholds)
      ? loadedCache
      : emptyCache(timezone, billingThresholds);
  const nextFiles = {};
  const stats = createStats(cache, timezone, billingThresholds);
  stats.codexHome = codexHome;
  stats.codexHomeSource = dataPaths.codexHomeSource;
  stats.sessionsDir = sessionsDir;
  stats.sessionsDirSource = dataPaths.sessionsDirSource;
  stats.codexHomeCandidatesChecked = dataPaths.candidatesChecked;
  stats.cacheLimitBytes = maxCacheBytes;
  stats.cacheFileBytesLoaded = loadResult.cacheFileBytes ?? 0;
  stats.cacheLoadSkippedBySize = Boolean(loadResult.skippedBySize);
  const aggregate = createAggregate();

  if (await shouldUseNativeBatchScanner(scannerMode)) {
    await collectEntriesWithGrepBatch({
      sessionsDir,
      discoveryMode,
      stats,
      cache,
      useCache,
      dateKeyer,
      timezone,
      billingThresholds,
      since,
      until,
      nextFiles,
      aggregate,
    });
  } else {
    await collectEntriesWithNode({
      sessionsDir,
      discoveryMode,
      stats,
      cache,
      useCache,
      dateKeyer,
      timezone,
      billingThresholds,
      since,
      until,
      nextFiles,
      aggregate,
    });
  }

  const report = buildReport(aggregate, stats, nextFiles);

  if (saveCache) {
    try {
      if (!stats.cacheDirty && loadResult.cacheFileBytes != null) {
        report.stats.cacheBytes = loadResult.cacheFileBytes;
        report.stats.cacheFile = cacheFile;
        report.stats.cacheSaveSkippedUnchanged = true;
      } else {
        const saveResult = await saveCacheFile(cacheFile, {
          version: CACHE_VERSION,
          source: CACHE_SOURCE,
          timezone,
          billingThresholds,
          updatedAt: new Date().toISOString(),
          files: nextFiles,
        }, maxCacheBytes);
        report.stats.cacheBytes = saveResult.bytes;
        report.stats.cacheSaveSkippedBySize = !saveResult.saved;
        if (saveResult.saved) {
          report.stats.cacheFile = cacheFile;
          report.stats.cacheEntriesSaved = Object.keys(nextFiles).length;
        }
      }
    } catch (error) {
      report.stats.cacheSaveSkippedByError = true;
      report.stats.cacheSaveError = error?.message ?? String(error);
    }
  } else {
    report.stats.cacheSaveSkippedBySize = false;
  }

  if (options.includePricing !== false) {
    report.pricing = await applyPricingToReport(report, options, pricingCatalog);
  } else {
    markPricingSkipped(report);
    report.pricing = { enabled: false, estimated: false, skipped: true };
  }

  if (!options.includeInternalBilling) {
    delete report._billing;
  }

  return report;
}

async function shouldUseNativeBatchScanner(scannerMode) {
  if (scannerMode === 'grep-batch') {
    return true;
  }
  if (scannerMode === 'node' || scannerMode === 'needle' || scannerMode === 'line' || scannerMode === 'grep') {
    return false;
  }
  return canUseNativeBatchScanner();
}

export async function applyPricingToReport(report, options = {}, pricingCatalog = null) {
  const catalog = pricingCatalog ?? (await loadPricingCatalog(pricingCatalogOptions(options)));
  const metadata = {
    enabled: true,
    estimated: true,
    tier: catalog.metadata.tier,
    source: catalog.metadata.source,
    sourceUrl: catalog.metadata.sourceUrl,
    fetchedAt: catalog.metadata.fetchedAt,
    cacheFile: catalog.metadata.cacheFile,
    cacheState: catalog.metadata.cacheState,
    ttlHours: catalog.metadata.ttlHours,
    modelCount: catalog.metadata.modelCount,
    billingThresholds: catalog.metadata.billingThresholds,
    priorityModels: catalog.metadata.priorityModels,
    models: {},
    missingModels: [],
    freeModels: [],
    aliasedModels: [],
    warnings: [],
  };
  const missingModels = new Set();
  const freeModels = new Set();
  const aliasedModels = [];
  const warnings = new Set();

  priceRows(report.daily, report._billing.daily, catalog, {
    metadata,
    missingModels,
    freeModels,
    aliasedModels,
    warnings,
    rowKey: (row) => row.key,
  });
  priceRows(report.monthly, report._billing.monthly, catalog, {
    metadata,
    missingModels,
    freeModels,
    aliasedModels,
    warnings,
    rowKey: (row) => row.key,
  });
  priceRows(report.sessions, report._billing.sessions, catalog, {
    metadata,
    missingModels,
    freeModels,
    aliasedModels,
    warnings,
    rowKey: (row) => row.sessionId,
  });

  report.totals.costUSD = roundCost(report.daily.reduce((sum, row) => sum + row.costUSD, 0));
  metadata.missingModels = [...missingModels].sort();
  metadata.freeModels = [...freeModels].sort();
  metadata.aliasedModels = dedupeAliases(aliasedModels);
  metadata.warnings = [...warnings].sort();
  return metadata;
}

function priceRows(rows, billing, catalog, context) {
  for (const row of rows) {
    let rowCost = 0;
    const key = context.rowKey(row);
    for (const [model, usage] of Object.entries(row.models ?? {})) {
      const resolved = catalog.getPricing(model);
      context.metadata.models[model] = resolved.detail;
      if (resolved.missing) {
        context.missingModels.add(model);
        continue;
      }
      if (resolved.free) {
        context.freeModels.add(model);
      }
      if (resolved.detail.matchedModel && resolved.detail.matchedModel !== model) {
        context.aliasedModels.push({ model, matchedModel: resolved.detail.matchedModel });
      }
      const events = billing?.[key]?.[model];
      const hasTierSupport = billingSummarySupportsPrice(events, resolved.price);
      rowCost += calculateCostFromUsageOrEvents(usage, resolved.price, events);
      if (usesTierPricing(resolved.price) && !hasTierSupport) {
        context.warnings.add(`${model}: tiered pricing fell back to aggregate token totals`);
      }
    }
    row.costUSD = roundCost(rowCost);
  }
}

function pricingCatalogOptions(options) {
  return {
    offline: options.pricingOffline,
    cacheFile: options.pricingCacheFile,
    ttlMs: options.pricingTtlMs,
    fetchTimeoutMs: options.pricingFetchTimeoutMs,
    pricingData: options.pricingData,
    tier: options.pricingTier,
    priorityModels: options.pricingPriorityModels,
  };
}

function normalizeBillingThresholds(thresholds = []) {
  const out = new Set(DEFAULT_BILLING_THRESHOLDS);
  for (const threshold of thresholds ?? []) {
    if (Number.isFinite(threshold) && threshold > 0) {
      out.add(Math.trunc(threshold));
    }
  }
  return [...out].sort((a, b) => a - b);
}

function sameBillingThresholds(left, right) {
  const normalizedLeft = normalizeBillingThresholds(left);
  const normalizedRight = normalizeBillingThresholds(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((threshold, index) => threshold === normalizedRight[index])
  );
}

function billingSummarySupportsPrice(events, price) {
  const thresholds = billingThresholdsForPrice(price);
  if (thresholds.length === 0) {
    return true;
  }
  if (!events) {
    return false;
  }
  if (Array.isArray(events)) {
    return events.length > 0;
  }
  if (!events.over || !Array.isArray(events.totals)) {
    return false;
  }
  return thresholds.every((threshold) => Array.isArray(events.over[threshold]));
}

function markPricingSkipped(report) {
  for (const rows of [report.daily, report.monthly, report.sessions]) {
    for (const row of rows) {
      row.costUSD = null;
    }
  }
  report.totals.costUSD = null;
}

async function collectEntriesWithNode(context) {
  for await (const task of planFileScans(context)) {
    if (task.kind === 'cached') {
      addCachedTask(task, context);
    } else if (task.kind === 'tail') {
      await scanTailTask(task, context);
    } else {
      const scan = await scanFileRange(
        task.file,
        task.sessionInfo,
        context.dateKeyer,
        0,
        undefined,
        context.billingThresholds,
        task.st.size,
      );
      finalizeFullScanTask(task, scan, context);
    }
  }
}

async function collectEntriesWithGrepBatch(context) {
  const fullScanTasks = [];
  for await (const task of planFileScans(context)) {
    if (task.kind === 'cached') {
      addCachedTask(task, context);
    } else if (task.kind === 'tail') {
      await scanTailTask(task, context);
    } else {
      fullScanTasks.push(task);
    }
  }

  if (fullScanTasks.length === 0) {
    return;
  }

  let scans;
  try {
    scans = await scanFilesWithGrepBatch(fullScanTasks, context.dateKeyer, context.billingThresholds);
  } catch (error) {
    context.stats.nativeBatchFallback = true;
    context.stats.nativeBatchFallbackReason = error?.message ?? String(error);
    scans = await scanFilesWithNode(fullScanTasks, context.dateKeyer, context.billingThresholds);
  }
  for (const task of fullScanTasks) {
    const scan = scans.get(task.file) ?? createFileScan(undefined, 'grep-batch');
    scan.endedWithNewline = await fileEndsWithNewline(task.file, task.st.size);
    finalizeFullScanTask(task, scan, context);
  }
}

async function* planFileScans(context) {
  for await (const discovered of discoverJsonlFiles(context.sessionsDir, { mode: context.discoveryMode, stats: context.stats })) {
    const file = discovered.path;
    const st = discovered.stat ?? (await stat(file));
    context.stats.filesSeen += 1;
    context.stats.bytesSeen += st.size;

    const sessionInfo = makeSessionInfo(file, context.sessionsDir);
    const oldEntry = context.useCache ? context.cache.files[file] : undefined;

    if (oldEntry && sameFile(st, oldEntry)) {
      yield { kind: 'cached', file, st, sessionInfo, oldEntry };
    } else if (oldEntry && appendableFile(st, oldEntry)) {
      yield { kind: 'tail', file, st, sessionInfo, oldEntry };
    } else {
      yield { kind: 'full', file, st, sessionInfo, oldEntry };
    }
  }
}

function addCachedTask(task, context) {
  context.nextFiles[task.file] = task.oldEntry;
  context.stats.filesFromCache += 1;
  context.stats.bytesSkippedByCache += task.st.size;
  addEntryToAggregate(task.oldEntry, context.aggregate, { since: context.since, until: context.until });
}

async function scanTailTask(task, context) {
  context.stats.cacheDirty = true;
  const tail = await scanFileRange(
    task.file,
    task.sessionInfo,
    context.dateKeyer,
    task.oldEntry.size,
    task.oldEntry.state,
    context.billingThresholds,
    task.st.size - task.oldEntry.size,
  );
  const entry = finalizeCacheEntry(task.st, mergeEntries(task.oldEntry, tail), task.file);
  context.nextFiles[task.file] = entry;
  context.stats.filesScannedTail += 1;
  context.stats.bytesRead += tail.stats.bytesRead;
  context.stats.bytesSkippedByTailCache += task.oldEntry.size;
  addScanStats(context.stats, tail.stats);
  addEntryToAggregate(entry, context.aggregate, { since: context.since, until: context.until });
}

function finalizeFullScanTask(task, scan, context) {
  context.stats.cacheDirty = true;
  scan.stats.bytesRead ||= task.st.size;
  const entry = finalizeCacheEntry(task.st, scan, task.file);
  context.nextFiles[task.file] = entry;
  context.stats.filesScannedFull += 1;
  context.stats.bytesRead += scan.stats.bytesRead;
  addScanStats(context.stats, scan.stats);
  if (task.oldEntry) {
    context.stats.filesCacheStale += 1;
  } else {
    context.stats.filesCacheMiss += 1;
  }
  addEntryToAggregate(entry, context.aggregate, { since: context.since, until: context.until });
}

function createFileScan(initialState = undefined, scannerMode = 'needle') {
  return {
    daily: {},
    sessionsByDate: {},
    billing: { daily: {}, sessionsByDate: {} },
    state: {
      previousTotals: cloneRawUsage(initialState?.previousTotals) ?? null,
      currentModel: initialState?.currentModel,
      currentModelIsFallback: Boolean(initialState?.currentModelIsFallback),
    },
    endedWithNewline: true,
    stats: {
      scannerMode,
      bytesRead: 0,
      nativeOutputBytes: 0,
      linesSeen: 0,
      candidateLinesSeen: 0,
      linesParsed: 0,
      linesJsonParsed: 0,
      tokenEvents: 0,
    },
  };
}

async function scanFilesWithGrepBatch(tasks, dateKeyer, billingThresholds) {
  if (process.env.CDXUSAGE_FORCE_NATIVE_BATCH_FAIL === '1') {
    throw new Error('forced native batch failure');
  }
  const scans = new Map();
  const contexts = new Map();
  for (const task of tasks) {
    const scan = createFileScan(undefined, 'grep-batch');
    scan.stats.bytesRead = task.st.size;
    scans.set(task.file, scan);
    contexts.set(task.file, {
      scan,
      sessionInfo: task.sessionInfo,
      dateKeyer,
      billingThresholds,
    });
  }

  const child = spawn(
    'xargs',
    [
      '-0',
      '-r',
      'perl',
      '-Mbytes',
      '-ne',
      NATIVE_BATCH_PERL_SCRIPT,
      '--',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4096);
  });
  const getStdinError = trackWritableError(child.stdin);
  const closed = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const nativeStatus = closed.then((status) => {
    if (status.error) {
      throw status.error;
    }
    if (status.code !== 0) {
      throw new Error(`xargs/perl exited with ${status.signal ?? status.code}: ${stderr.trim()}`);
    }
    return status;
  });
  const outputConsumed = consumeGrepBatchOutput(child.stdout, contexts);

  try {
    await Promise.race([writeNativeBatchInput(child.stdin, tasks, getStdinError), nativeStatus]);
  } catch (error) {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    await Promise.allSettled([outputConsumed, nativeStatus]);
    throw error;
  }

  try {
    await Promise.race([outputConsumed, nativeStatus]);
    await outputConsumed;
    await nativeStatus;
  } catch (error) {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    await Promise.allSettled([outputConsumed, nativeStatus]);
    throw error;
  }
  for (const task of tasks) {
    const scan = scans.get(task.file);
    if (!scan) {
      continue;
    }
    const context = contexts.get(task.file);
    scan.stats.linesSeen = context?.sourceLinesSeen ?? scan.stats.linesSeen;
  }
  return scans;
}

function canUseNativeBatchScanner() {
  if (process.platform !== 'linux') {
    return false;
  }
  nativeBatchCapabilityPromise ??= Promise.all([
    commandSucceeds('perl', ['-Mbytes', '-e', '']),
    commandSucceeds('xargs', ['-r', 'true']),
  ]).then((results) => results.every(Boolean));
  return nativeBatchCapabilityPromise;
}

function commandSucceeds(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

function trackWritableError(stream) {
  let streamError = null;
  stream.on('error', (error) => {
    streamError ??= error;
  });
  return () => streamError;
}

async function writeNativeBatchInput(stdin, tasks, getStreamError = () => null) {
  for (const task of tasks) {
    const streamError = getStreamError();
    if (streamError) {
      throw streamError;
    }
    if (!stdin.write(`${task.file}\0`)) {
      await waitForDrainOrError(stdin, getStreamError);
    }
  }
  const streamError = getStreamError();
  if (streamError) {
    throw streamError;
  }
  stdin.end();
}

function waitForDrainOrError(stream, getStreamError) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const streamError = getStreamError();
    if (streamError) {
      reject(streamError);
      return;
    }
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

async function consumeGrepBatchOutput(stdout, contexts) {
  let buffer = Buffer.alloc(0);
  let parts = [];
  for await (const chunk of stdout) {
    buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      const nul = buffer.indexOf(0);
      if (nul === -1) {
        break;
      }
      parts.push(buffer.subarray(0, nul));
      buffer = buffer.subarray(nul + 1);
      while (parts.length >= 3) {
        const [typeBuf, fileBuf, payload] = parts.splice(0, 3);
        const type = typeBuf.toString('utf8');
        const file = fileBuf.toString('utf8');
        const context = contexts.get(file);
        if (!context) {
          continue;
        }
        if (type === 'L') {
          context.scan.stats.nativeOutputBytes += payload.length;
          processLine(payload, context);
        } else if (type === 'C') {
          const parsed = Number(payload.toString('utf8'));
          if (Number.isFinite(parsed)) {
            context.sourceLinesSeen = parsed;
          }
        }
      }
    }
  }
}

async function scanFilesWithNode(tasks, dateKeyer, billingThresholds) {
  const scans = new Map();
  for (const task of tasks) {
    scans.set(
      task.file,
      await scanFileRange(task.file, task.sessionInfo, dateKeyer, 0, undefined, billingThresholds, task.st.size),
    );
  }
  return scans;
}

async function scanFileRange(
  file,
  sessionInfo,
  dateKeyer,
  start = 0,
  initialState = undefined,
  billingThresholds = DEFAULT_BILLING_THRESHOLDS,
  sourceBytes = undefined,
) {
  const scan = createFileScan(initialState, process.env.CDXUSAGE_SCAN_MODE === 'line' ? 'line' : 'needle');

  if (process.env.CDXUSAGE_SCAN_MODE === 'grep' && start === 0) {
    scan.stats.scannerMode = 'grep';
    await scanFileWithGrep(file, scan, {
      scan,
      sessionInfo,
      dateKeyer,
      billingThresholds,
      sourceBytes,
    });
    return scan;
  }

  const stream = createReadStream(file, { start, highWaterMark: 4 * 1024 * 1024 });

  if (scan.stats.scannerMode === 'line') {
    await scanStreamByLine(stream, scan, {
      scan,
      sessionInfo,
      dateKeyer,
      billingThresholds,
    });
    return scan;
  }

  await scanStreamByNeedle(stream, scan, {
    scan,
    sessionInfo,
    dateKeyer,
    billingThresholds,
  });
  return scan;
}

async function scanStreamByLine(stream, scan, context) {
  let carry = Buffer.alloc(0);
  let lastByte;
  for await (const chunk of stream) {
    scan.stats.bytesRead += chunk.length;
    if (chunk.length > 0) {
      lastByte = chunk[chunk.length - 1];
    }
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    let lineStart = 0;
    for (;;) {
      const newline = buf.indexOf(10, lineStart);
      if (newline === -1) {
        break;
      }
      let lineEnd = newline;
      if (lineEnd > lineStart && buf[lineEnd - 1] === 13) {
        lineEnd -= 1;
      }
      scan.stats.linesSeen += 1;
      processLine(buf.subarray(lineStart, lineEnd), context);
      lineStart = newline + 1;
    }
    carry = lineStart < buf.length ? Buffer.from(buf.subarray(lineStart)) : Buffer.alloc(0);
  }

  if (carry.length > 0) {
    scan.stats.linesSeen += 1;
    processLine(carry, context);
  }
  scan.endedWithNewline = scan.stats.bytesRead === 0 || lastByte === 10;
}

async function scanFileWithGrep(file, scan, context) {
  scan.stats.bytesRead = context.sourceBytes ?? 0;
  const child = spawn('grep', ['-aF', '-e', 'token_count', '-e', 'turn_context', '--', file], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4096);
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  let carry = Buffer.alloc(0);
  for await (const chunk of child.stdout) {
    scan.stats.nativeOutputBytes += chunk.length;
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    let lineStart = 0;
    for (;;) {
      const newline = buf.indexOf(10, lineStart);
      if (newline === -1) {
        break;
      }
      let lineEnd = newline;
      if (lineEnd > lineStart && buf[lineEnd - 1] === 13) {
        lineEnd -= 1;
      }
      processLine(buf.subarray(lineStart, lineEnd), context);
      lineStart = newline + 1;
    }
    carry = lineStart < buf.length ? Buffer.from(buf.subarray(lineStart)) : Buffer.alloc(0);
  }
  if (carry.length > 0) {
    processLine(carry, context);
  }
  scan.stats.linesSeen = scan.stats.candidateLinesSeen;

  const status = await closed;
  if (status.code !== 0 && status.code !== 1) {
    throw new Error(`grep exited with ${status.signal ?? status.code}: ${stderr.trim()}`);
  }
  scan.endedWithNewline = await fileEndsWithNewline(file, context.sourceBytes);
}

async function fileEndsWithNewline(file, size = undefined) {
  if (!Number.isFinite(size) || size <= 0) {
    return true;
  }
  let handle;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.allocUnsafe(1);
    const result = await handle.read(buffer, 0, 1, size - 1);
    return result.bytesRead === 0 || buffer[0] === 10;
  } catch {
    return true;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function scanStreamByNeedle(stream, scan, context) {
  let carry = Buffer.alloc(0);
  let lastByte;
  for await (const chunk of stream) {
    scan.stats.bytesRead += chunk.length;
    if (chunk.length > 0) {
      lastByte = chunk[chunk.length - 1];
    }
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    const completeEnd = buf.lastIndexOf(10) + 1;
    if (completeEnd === 0) {
      carry = Buffer.from(buf);
      continue;
    }

    scan.stats.linesSeen += countByte(buf, 10, 0, completeEnd);
    for (const lineStart of collectNeedleLineStarts(buf, completeEnd)) {
      let lineEnd = buf.indexOf(10, lineStart);
      if (lineEnd === -1 || lineEnd > completeEnd) {
        lineEnd = completeEnd;
      }
      if (lineEnd > lineStart && buf[lineEnd - 1] === 13) {
        lineEnd -= 1;
      }
      processLine(buf.subarray(lineStart, lineEnd), context);
    }
    carry = completeEnd < buf.length ? Buffer.from(buf.subarray(completeEnd)) : Buffer.alloc(0);
  }

  if (carry.length > 0 && lineHasNeedle(carry)) {
    scan.stats.linesSeen += 1;
    processLine(carry, context);
  } else if (carry.length > 0) {
    scan.stats.linesSeen += 1;
  }
  scan.endedWithNewline = scan.stats.bytesRead === 0 || lastByte === 10;
}

function collectNeedleLineStarts(buf, end) {
  const starts = new Set();
  for (const needle of SCAN_NEEDLES) {
    let offset = 0;
    for (;;) {
      const hit = buf.indexOf(needle, offset);
      if (hit === -1 || hit >= end) {
        break;
      }
      const newline = buf.lastIndexOf(10, hit);
      starts.add(newline === -1 ? 0 : newline + 1);
      offset = hit + needle.length;
    }
  }
  return [...starts].sort((a, b) => a - b);
}

function lineHasNeedle(line) {
  return line.includes(TOKEN_NEEDLE) || line.includes(TURN_NEEDLE);
}

function countByte(buf, byte, start = 0, end = buf.length) {
  let count = 0;
  for (let offset = start; offset < end; offset += 1) {
    if (buf[offset] === byte) {
      count += 1;
    }
  }
  return count;
}

function parseTokenLineJson(line) {
  let entry;
  try {
    entry = JSON.parse(line.toString('utf8'));
  } catch {
    return null;
  }
  if (entry?.type !== 'event_msg' || entry?.payload?.type !== 'token_count' || !entry.timestamp) {
    return null;
  }
  const info = entry.payload.info ?? {};
  return {
    timestamp: entry.timestamp,
    model: extractModel(entry.payload, info),
    lastUsage: normalizeRawUsage(info.last_token_usage),
    totalUsage: normalizeRawUsage(info.total_token_usage),
  };
}

function processLine(line, context) {
  const { scan, sessionInfo, dateKeyer } = context;
  const billingThresholds = context.billingThresholds ?? DEFAULT_BILLING_THRESHOLDS;
  if (line.length === 0) {
    return;
  }
  if (line.includes(TURN_NEEDLE)) {
    scan.stats.candidateLinesSeen += 1;
    const model = extractTurnModelFast(line);
    if (model) {
      scan.state.currentModel = model;
      scan.state.currentModelIsFallback = false;
    }
    return;
  }
  if (!line.includes(TOKEN_NEEDLE)) {
    return;
  }
  scan.stats.candidateLinesSeen += 1;

  const parsed = parseTokenLineJson(line);
  if (!parsed) {
    return;
  }
  scan.stats.linesJsonParsed += 1;
  scan.stats.linesParsed += 1;
  const lastUsage = parsed.lastUsage;
  const totalUsage = parsed.totalUsage;
  let raw = lastUsage;
  if (!raw && totalUsage) {
    raw = subtractRawUsage(totalUsage, scan.state.previousTotals);
  }
  if (totalUsage) {
    scan.state.previousTotals = totalUsage;
  }
  if (!raw) {
    return;
  }
  if (!totalUsage && lastUsage) {
    scan.state.previousTotals = addRawUsage(scan.state.previousTotals, lastUsage);
  }

  const delta = {
    inputTokens: raw.input_tokens,
    cachedInputTokens: Math.min(raw.cached_input_tokens, raw.input_tokens),
    outputTokens: raw.output_tokens,
    reasoningOutputTokens: raw.reasoning_output_tokens,
    totalTokens: raw.total_tokens > 0 ? raw.total_tokens : raw.input_tokens + raw.output_tokens,
  };
  if (
    delta.inputTokens === 0 &&
    delta.cachedInputTokens === 0 &&
    delta.outputTokens === 0 &&
    delta.reasoningOutputTokens === 0
  ) {
    return;
  }

  const extractedModel = parsed.model;
  let isFallback = false;
  if (extractedModel) {
    scan.state.currentModel = extractedModel;
    scan.state.currentModelIsFallback = false;
  }
  let model = extractedModel ?? scan.state.currentModel;
  if (!model) {
    model = 'gpt-5';
    isFallback = true;
    scan.state.currentModel = model;
    scan.state.currentModelIsFallback = true;
  } else if (!extractedModel && scan.state.currentModelIsFallback) {
    isFallback = true;
  }

  const date = toDateKey(parsed.timestamp, dateKeyer);
  const activityTimestamp = toActivityTimestamp(parsed.timestamp);
  const day = scan.daily[date] ?? { ...emptyUsage(), models: {} };
  scan.daily[date] = day;
  addUsage(day, delta);
  addModelUsage(day.models, model, delta, isFallback);

  const sessionDay = scan.sessionsByDate[date] ?? {};
  scan.sessionsByDate[date] = sessionDay;
  const session = sessionDay[sessionInfo.sessionId] ?? {
    sessionId: sessionInfo.sessionId,
    sessionFile: sessionInfo.sessionFile,
    directory: sessionInfo.directory,
    lastActivity: activityTimestamp,
    ...emptyUsage(),
    models: {},
  };
  sessionDay[sessionInfo.sessionId] = session;
  if (compareActivityTimestamp(activityTimestamp, session.lastActivity) > 0) {
    session.lastActivity = activityTimestamp;
  }
  addUsage(session, delta);
  addModelUsage(session.models, model, delta, isFallback);

  addBillingSummary(scan.billing.daily, date, model, delta, billingThresholds);
  addSessionBillingSummary(scan.billing.sessionsByDate, date, sessionInfo.sessionId, model, delta, billingThresholds);
  scan.stats.tokenEvents += 1;
}

function buildReport(aggregate, stats, nextFiles) {
  const daily = [...aggregate.daily.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, usage]) => ({ key, ...usage }));
  const { rows: monthly, billing: monthlyBilling } = buildMonthlyRows(daily, aggregate.billing.daily);
  const sessions = [...aggregate.sessions.entries()]
    .sort(([, a], [, b]) => compareActivityTimestamp(a.lastActivity, b.lastActivity))
    .map(([, session]) => ({ ...session }));
  const totals = emptyUsage();
  for (const day of daily) {
    addUsage(totals, day);
  }

  const filesEligibleForCache = stats.filesSeen - stats.filesSkippedByMtime - stats.filesSkippedByPathDate;
  return {
    daily,
    monthly,
    sessions,
    totals,
    _billing: {
      daily: aggregate.billing.daily,
      monthly: monthlyBilling,
      sessions: aggregate.billing.sessions,
    },
    stats: {
      ...stats,
      filesEligibleForCache,
      cacheEntriesPrepared: Object.keys(nextFiles).length,
      cacheEntriesSaved: 0,
      cacheHitRate: stats.filesSeen > 0 ? roundRatio(stats.filesFromCache / Math.max(1, stats.filesSeen)) : 0,
      cacheHitRateEligible:
        filesEligibleForCache > 0 ? roundRatio(stats.filesFromCache / Math.max(1, filesEligibleForCache)) : 0,
      cacheFile: null,
    },
  };
}

function buildMonthlyRows(dailyRows, dailyBilling) {
  const byMonth = new Map();
  const monthlyBilling = {};
  for (const row of dailyRows) {
    const month = row.key.slice(0, 7);
    const target = byMonth.get(month) ?? { key: month, ...emptyUsage(), models: {} };
    byMonth.set(month, target);
    addUsage(target, row);
    for (const [model, usage] of Object.entries(row.models ?? {})) {
      mergeModelUsage(target.models, model, usage);
    }
    const targetBilling = monthlyBilling[month] ?? {};
    monthlyBilling[month] = targetBilling;
    for (const [model, summary] of Object.entries(dailyBilling[row.key] ?? {})) {
      targetBilling[model] = mergeBillingSummary(targetBilling[model], summary);
    }
  }
  const rows = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => row);
  return { rows, billing: monthlyBilling };
}

function addEntryToAggregate(entry, aggregate, filters) {
  for (const [date, usage] of Object.entries(entry.daily ?? {})) {
    if (!isWithinRange(date, filters.since, filters.until)) {
      continue;
    }
    const target = aggregate.daily.get(date) ?? { ...emptyUsage(), models: {} };
    aggregate.daily.set(date, target);
    addUsage(target, usage);
    for (const [model, modelUsage] of Object.entries(usage.models ?? {})) {
      mergeModelUsage(target.models, model, modelUsage);
    }
  }

  for (const [date, sessions] of Object.entries(entry.sessionsByDate ?? {})) {
    if (!isWithinRange(date, filters.since, filters.until)) {
      continue;
    }
    for (const [sessionId, session] of Object.entries(sessions ?? {})) {
      const sessionLastActivity = toActivityTimestamp(session.lastActivity);
      const target = aggregate.sessions.get(sessionId) ?? {
        sessionId,
        sessionFile: session.sessionFile,
        directory: session.directory,
        lastActivity: sessionLastActivity,
        ...emptyUsage(),
        models: {},
      };
      aggregate.sessions.set(sessionId, target);
      if (compareActivityTimestamp(sessionLastActivity, target.lastActivity) > 0) {
        target.lastActivity = sessionLastActivity;
      }
      addUsage(target, session);
      for (const [model, modelUsage] of Object.entries(session.models ?? {})) {
        mergeModelUsage(target.models, model, modelUsage);
      }
    }
  }

  for (const [date, models] of Object.entries(entry.billing?.daily ?? {})) {
    if (!isWithinRange(date, filters.since, filters.until)) {
      continue;
    }
    const target = aggregate.billing.daily[date] ?? {};
    aggregate.billing.daily[date] = target;
    for (const [model, summary] of Object.entries(models ?? {})) {
      target[model] = mergeBillingSummary(target[model], summary);
    }
  }

  for (const [date, sessions] of Object.entries(entry.billing?.sessionsByDate ?? {})) {
    if (!isWithinRange(date, filters.since, filters.until)) {
      continue;
    }
    for (const [sessionId, models] of Object.entries(sessions ?? {})) {
      const target = aggregate.billing.sessions[sessionId] ?? {};
      aggregate.billing.sessions[sessionId] = target;
      for (const [model, summary] of Object.entries(models ?? {})) {
        target[model] = mergeBillingSummary(target[model], summary);
      }
    }
  }
}

function finalizeCacheEntry(st, scan, file) {
  return {
    path: file,
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    endedWithNewline: scan.endedWithNewline,
    daily: scan.daily,
    sessionsByDate: scan.sessionsByDate,
    billing: {
      daily: scan.billing.daily,
      sessionsByDate: scan.billing.sessionsByDate,
    },
    state: scan.state,
    stats: scan.stats,
  };
}

function mergeEntries(base, tail) {
  const daily = cloneDaily(base.daily);
  const sessionsByDate = cloneSessionsByDate(base.sessionsByDate);
  const billing = {
    daily: cloneBillingByKey(base.billing?.daily),
    sessionsByDate: cloneBillingByDateSession(base.billing?.sessionsByDate),
  };
  mergeDaily(daily, tail.daily);
  mergeSessionsByDate(sessionsByDate, tail.sessionsByDate);
  mergeBillingByKey(billing.daily, tail.billing.daily);
  mergeBillingByDateSession(billing.sessionsByDate, tail.billing.sessionsByDate);
  return {
    daily,
    sessionsByDate,
    billing,
    state: tail.state,
    endedWithNewline: tail.endedWithNewline,
    stats: {
      bytesRead: (base.stats?.bytesRead ?? base.size ?? 0) + tail.stats.bytesRead,
      linesSeen: (base.stats?.linesSeen ?? 0) + tail.stats.linesSeen,
      candidateLinesSeen: (base.stats?.candidateLinesSeen ?? 0) + (tail.stats.candidateLinesSeen ?? 0),
      linesParsed: (base.stats?.linesParsed ?? 0) + tail.stats.linesParsed,
      linesJsonParsed: (base.stats?.linesJsonParsed ?? 0) + (tail.stats.linesJsonParsed ?? 0),
      tokenEvents: (base.stats?.tokenEvents ?? 0) + tail.stats.tokenEvents,
      nativeOutputBytes: (base.stats?.nativeOutputBytes ?? 0) + (tail.stats.nativeOutputBytes ?? 0),
    },
  };
}

function createAggregate() {
  return {
    daily: new Map(),
    sessions: new Map(),
    billing: {
      daily: {},
      monthly: {},
      sessions: {},
    },
  };
}

function createStats(cache, timezone, billingThresholds = DEFAULT_BILLING_THRESHOLDS) {
  return {
    timezone,
    billingThresholds,
    filesSeen: 0,
    filesSkippedByMtime: 0,
    filesSkippedByPathDate: 0,
    filesFromCache: 0,
    filesScannedFull: 0,
    filesScannedTail: 0,
    filesCacheMiss: 0,
    filesCacheStale: 0,
    linesSeen: 0,
    candidateLinesSeen: 0,
    linesParsed: 0,
    linesJsonParsed: 0,
    tokenEvents: 0,
    bytesSeen: 0,
    bytesRead: 0,
    nativeOutputBytes: 0,
    bytesSkippedByMtime: 0,
    bytesSkippedByPathDate: 0,
    bytesSkippedByCache: 0,
    bytesSkippedByTailCache: 0,
    cacheEntriesLoaded: Object.keys(cache.files).length,
    cacheEntriesSaved: 0,
    cacheDirty: false,
    cacheSaveSkippedByError: false,
    cacheSaveError: null,
    cacheSaveSkippedUnchanged: false,
    nativeBatchFallback: false,
    nativeBatchFallbackReason: null,
    discoveryMode: null,
    scannerModes: {},
  };
}

function makeSessionInfo(file, sessionsDir) {
  const relative = path.relative(sessionsDir, file).split(path.sep).join('/');
  const sessionId = relative.replace(/\.jsonl$/i, '');
  const separatorIndex = sessionId.lastIndexOf('/');
  return {
    sessionId,
    directory: separatorIndex >= 0 ? sessionId.slice(0, separatorIndex) : '',
    sessionFile: separatorIndex >= 0 ? sessionId.slice(separatorIndex + 1) : sessionId,
  };
}

function extractTurnModelFast(line) {
  const prefix = line.toString('utf8', 0, Math.min(line.length, 65536));
  const match = prefix.match(MODEL_RE);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

function createDateKeyer(timezone) {
  const safe = safeTimeZone(timezone);
  if (safe === 'UTC') {
    return (timestamp) => {
      if (isUtcIsoTimestamp(timestamp)) {
        return timestamp.slice(0, 10);
      }
      return new Date(timestamp).toISOString().slice(0, 10);
    };
  }
  const formatter = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: safe,
  });
  return (timestamp) => formatter.format(new Date(timestamp));
}

function isUtcIsoTimestamp(value) {
  return (
    typeof value === 'string' &&
    value.length >= 20 &&
    value[4] === '-' &&
    value[7] === '-' &&
    value[10] === 'T' &&
    value.endsWith('Z')
  );
}

function isCanonicalUtcTimestamp(value) {
  return (
    typeof value === 'string' &&
    value.length === 24 &&
    value[4] === '-' &&
    value[7] === '-' &&
    value[10] === 'T' &&
    value[13] === ':' &&
    value[16] === ':' &&
    value[19] === '.' &&
    value.endsWith('Z')
  );
}

function toActivityTimestamp(timestamp) {
  if (isCanonicalUtcTimestamp(timestamp)) {
    return timestamp;
  }
  const ms = Date.parse(timestamp);
  if (Number.isFinite(ms)) {
    return new Date(ms).toISOString();
  }
  return String(timestamp ?? '');
}

function compareActivityTimestamp(left, right) {
  return toActivityTimestamp(left).localeCompare(toActivityTimestamp(right));
}

function toDateKey(timestamp, dateKeyer) {
  return dateKeyer(timestamp);
}

export function toMonthKey(dateKey) {
  return dateKey.slice(0, 7);
}

export function normalizeDate(value) {
  if (!value) {
    return undefined;
  }
  const compact = String(value).replaceAll('-', '').trim();
  if (!/^\d{8}$/.test(compact)) {
    throw new Error(`Invalid date format: ${value}. Expected YYYYMMDD or YYYY-MM-DD.`);
  }
  const year = Number(compact.slice(0, 4));
  const month = Number(compact.slice(4, 6));
  const day = Number(compact.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid date: ${value}. Expected a real date in YYYYMMDD or YYYY-MM-DD.`);
  }
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

export function isWithinRange(dateKey, since, until) {
  const value = dateKey.replaceAll('-', '');
  const sinceValue = since?.replaceAll('-', '');
  const untilValue = until?.replaceAll('-', '');
  if (sinceValue != null && value < sinceValue) {
    return false;
  }
  if (untilValue != null && value > untilValue) {
    return false;
  }
  return true;
}

export function safeTimeZone(timezone) {
  if (timezone == null || String(timezone).trim() === '') {
    return 'UTC';
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
}

function sameFile(st, entry) {
  return (
    entry.dev === st.dev &&
    entry.ino === st.ino &&
    entry.size === st.size &&
    Math.abs(entry.mtimeMs - st.mtimeMs) < 0.001
  );
}

function appendableFile(st, entry) {
  return (
    entry.dev === st.dev &&
    entry.ino === st.ino &&
    entry.endedWithNewline === true &&
    st.size > entry.size &&
    st.mtimeMs >= entry.mtimeMs
  );
}

async function loadCache(cacheFile, maxCacheBytes) {
  try {
    const cacheStat = await stat(cacheFile);
    if (cacheStat.size > maxCacheBytes) {
      return { cache: emptyCache(), skippedBySize: true, cacheFileBytes: cacheStat.size };
    }
    const parsed = JSON.parse(await readFile(cacheFile, 'utf8'));
    if (parsed?.version === CACHE_VERSION && parsed?.source === CACHE_SOURCE && parsed.files && parsed.timezone) {
      return { cache: parsed, cacheFileBytes: cacheStat.size };
    }
  } catch {
    // Missing or corrupt cache is a cold run.
  }
  return { cache: emptyCache() };
}

async function saveCacheFile(cacheFile, cache, maxCacheBytes) {
  await mkdir(path.dirname(cacheFile), { recursive: true });
  const tmp = `${cacheFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const stream = createWriteStream(tmp, { encoding: 'utf8' });
  let bytes = 0;
  const write = async (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxCacheBytes) {
      throw new CacheTooLargeError(bytes);
    }
    if (!stream.write(chunk)) {
      await onceDrain(stream);
    }
  };

  try {
    await writeCacheJson(cache, write);
    stream.end();
    await finished(stream);
    await rename(tmp, cacheFile);
    return { saved: true, bytes };
  } catch (error) {
    if (error instanceof CacheTooLargeError) {
      stream.destroy();
      await finished(stream).catch(() => {});
      await unlink(tmp).catch(() => {});
      return { saved: false, bytes: error.bytes };
    }
    stream.destroy();
    await finished(stream).catch(() => {});
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

async function writeCacheJson(cache, write) {
  await write('{');
  await write(`"version":${JSON.stringify(cache.version ?? CACHE_VERSION)}`);
  await write(`,"source":${JSON.stringify(cache.source ?? CACHE_SOURCE)}`);
  await write(`,"timezone":${JSON.stringify(cache.timezone ?? '')}`);
  await write(`,"billingThresholds":${JSON.stringify(cache.billingThresholds ?? DEFAULT_BILLING_THRESHOLDS)}`);
  await write(`,"updatedAt":${JSON.stringify(cache.updatedAt ?? new Date().toISOString())}`);
  await write(',"files":{');
  let first = true;
  for (const [file, entry] of Object.entries(cache.files ?? {})) {
    if (!first) {
      await write(',');
    }
    first = false;
    await write(JSON.stringify(file));
    await write(':');
    await write(JSON.stringify(entry));
  }
  await write('}}\n');
}

async function onceDrain(stream) {
  await new Promise((resolve, reject) => {
    const onDrain = () => {
      stream.off('error', onError);
      resolve();
    };
    const onError = (error) => {
      stream.off('drain', onDrain);
      reject(error);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

class CacheTooLargeError extends Error {
  constructor(bytes) {
    super('cache exceeds byte limit');
    this.bytes = bytes;
  }
}

function emptyCache(timezone = '', billingThresholds = DEFAULT_BILLING_THRESHOLDS) {
  return {
    version: CACHE_VERSION,
    source: CACHE_SOURCE,
    timezone,
    billingThresholds,
    updatedAt: new Date().toISOString(),
    files: {},
  };
}

function normalizeCacheByteLimit(value) {
  const parsed = Number(value ?? DEFAULT_MAX_CACHE_BYTES);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_CACHE_BYTES;
  }
  return Math.max(Math.trunc(parsed), 1024 * 1024);
}

function addScanStats(target, scanStats) {
  if (scanStats.scannerMode) {
    target.scannerModes[scanStats.scannerMode] = (target.scannerModes[scanStats.scannerMode] ?? 0) + 1;
  }
  target.linesSeen += scanStats.linesSeen;
  target.candidateLinesSeen += scanStats.candidateLinesSeen ?? 0;
  target.linesParsed += scanStats.linesParsed;
  target.linesJsonParsed += scanStats.linesJsonParsed ?? 0;
  target.tokenEvents += scanStats.tokenEvents;
  target.nativeOutputBytes += scanStats.nativeOutputBytes ?? 0;
}

function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(target, delta) {
  target.inputTokens += delta.inputTokens ?? 0;
  target.cachedInputTokens += delta.cachedInputTokens ?? 0;
  target.outputTokens += delta.outputTokens ?? 0;
  target.reasoningOutputTokens += delta.reasoningOutputTokens ?? 0;
  target.totalTokens += delta.totalTokens ?? 0;
}

function addModelUsage(models, model, delta, isFallback = false) {
  const usage = models[model] ?? { ...emptyUsage(), isFallback: false };
  models[model] = usage;
  addUsage(usage, delta);
  usage.isFallback = usage.isFallback || Boolean(isFallback);
}

function mergeModelUsage(models, model, source) {
  const target = models[model] ?? { ...emptyUsage(), isFallback: false };
  models[model] = target;
  addUsage(target, source);
  target.isFallback = target.isFallback || Boolean(source.isFallback);
}

function cloneDaily(daily) {
  const out = {};
  for (const [date, usage] of Object.entries(daily ?? {})) {
    const day = { ...emptyUsage(), models: {} };
    addUsage(day, usage);
    for (const [model, modelUsage] of Object.entries(usage.models ?? {})) {
      day.models[model] = { ...emptyUsage(), ...modelUsage, isFallback: Boolean(modelUsage.isFallback) };
    }
    out[date] = day;
  }
  return out;
}

function mergeDaily(target, source) {
  for (const [date, usage] of Object.entries(source ?? {})) {
    const day = target[date] ?? { ...emptyUsage(), models: {} };
    target[date] = day;
    addUsage(day, usage);
    for (const [model, modelUsage] of Object.entries(usage.models ?? {})) {
      mergeModelUsage(day.models, model, modelUsage);
    }
  }
}

function cloneSessionsByDate(source) {
  const out = {};
  for (const [date, sessions] of Object.entries(source ?? {})) {
    const day = {};
    for (const [sessionId, session] of Object.entries(sessions ?? {})) {
      const cloned = {
        sessionId,
        sessionFile: session.sessionFile,
        directory: session.directory,
        lastActivity: session.lastActivity,
        ...emptyUsage(),
        models: {},
      };
      addUsage(cloned, session);
      for (const [model, modelUsage] of Object.entries(session.models ?? {})) {
        cloned.models[model] = { ...emptyUsage(), ...modelUsage, isFallback: Boolean(modelUsage.isFallback) };
      }
      day[sessionId] = cloned;
    }
    out[date] = day;
  }
  return out;
}

function mergeSessionsByDate(target, source) {
  for (const [date, sessions] of Object.entries(source ?? {})) {
    const day = target[date] ?? {};
    target[date] = day;
    for (const [sessionId, session] of Object.entries(sessions ?? {})) {
      const targetSession = day[sessionId] ?? {
        sessionId,
        sessionFile: session.sessionFile,
        directory: session.directory,
        lastActivity: session.lastActivity,
        ...emptyUsage(),
        models: {},
      };
      day[sessionId] = targetSession;
      if (session.lastActivity > targetSession.lastActivity) {
        targetSession.lastActivity = session.lastActivity;
      }
      addUsage(targetSession, session);
      for (const [model, modelUsage] of Object.entries(session.models ?? {})) {
        mergeModelUsage(targetSession.models, model, modelUsage);
      }
    }
  }
}

function addBillingSummary(target, key, model, delta, billingThresholds = DEFAULT_BILLING_THRESHOLDS) {
  const row = target[key] ?? {};
  target[key] = row;
  addBillingSummaryForModel(row, model, delta, billingThresholds);
}

function addBillingSummaryForModel(row, model, delta, billingThresholds = DEFAULT_BILLING_THRESHOLDS) {
  const summary = row[model] ?? {
    version: 1,
    count: 0,
    totals: [0, 0, 0],
    over: Object.fromEntries(billingThresholds.map((threshold) => [threshold, [0, 0, 0]])),
  };
  row[model] = summary;
  const inputTokens = delta.inputTokens ?? 0;
  const cachedInputTokens = Math.min(delta.cachedInputTokens ?? 0, inputTokens);
  const values = [Math.max(inputTokens - cachedInputTokens, 0), cachedInputTokens, delta.outputTokens ?? 0];
  summary.count += 1;
  for (let i = 0; i < values.length; i += 1) {
    summary.totals[i] += values[i];
  }
  for (const threshold of billingThresholds) {
    const bucket = summary.over[threshold];
    const over = contextOverThreshold(inputTokens, cachedInputTokens, values[2], threshold);
    for (let i = 0; i < values.length; i += 1) {
      bucket[i] += over[i];
    }
  }
}

function contextOverThreshold(inputTokens, cachedInputTokens, outputTokens, threshold) {
  const input = Math.max(inputTokens, 0);
  const cached = Math.min(Math.max(cachedInputTokens, 0), input);
  const nonCached = Math.max(input - cached, 0);
  if (input <= threshold) {
    return [0, 0, 0];
  }
  return [nonCached, cached, outputTokens ?? 0];
}

function addSessionBillingSummary(target, date, sessionId, model, delta, billingThresholds = DEFAULT_BILLING_THRESHOLDS) {
  const day = target[date] ?? {};
  target[date] = day;
  const session = day[sessionId] ?? {};
  day[sessionId] = session;
  addBillingSummaryForModel(session, model, delta, billingThresholds);
}

function cloneBillingByKey(source) {
  const out = {};
  for (const [key, models] of Object.entries(source ?? {})) {
    out[key] = cloneBillingModels(models);
  }
  return out;
}

function cloneBillingModels(models) {
  const out = {};
  for (const [model, summary] of Object.entries(models ?? {})) {
    out[model] = cloneBillingSummary(summary);
  }
  return out;
}

function mergeBillingByKey(target, source) {
  for (const [key, models] of Object.entries(source ?? {})) {
    const row = target[key] ?? {};
    target[key] = row;
    for (const [model, summary] of Object.entries(models ?? {})) {
      row[model] = mergeBillingSummary(row[model], summary);
    }
  }
}

function cloneBillingByDateSession(source) {
  const out = {};
  for (const [date, sessions] of Object.entries(source ?? {})) {
    const day = {};
    for (const [sessionId, models] of Object.entries(sessions ?? {})) {
      day[sessionId] = cloneBillingModels(models);
    }
    out[date] = day;
  }
  return out;
}

function mergeBillingByDateSession(target, source) {
  for (const [date, sessions] of Object.entries(source ?? {})) {
    const day = target[date] ?? {};
    target[date] = day;
    for (const [sessionId, models] of Object.entries(sessions ?? {})) {
      const row = day[sessionId] ?? {};
      day[sessionId] = row;
      for (const [model, summary] of Object.entries(models ?? {})) {
        row[model] = mergeBillingSummary(row[model], summary);
      }
    }
  }
}

function cloneBillingSummary(summary) {
  const out = {
    version: summary?.version ?? 1,
    count: summary?.count ?? 0,
    totals: (summary?.totals ?? [0, 0, 0]).slice(),
    over: {},
  };
  for (const [threshold, values] of Object.entries(summary?.over ?? {})) {
    out.over[threshold] = values.slice();
  }
  return out;
}

function mergeBillingSummary(target, source) {
  if (!target) {
    return cloneBillingSummary(source);
  }
  const out = cloneBillingSummary(target);
  out.count += source?.count ?? 0;
  const sourceTotals = source?.totals ?? [0, 0, 0];
  for (let i = 0; i < out.totals.length; i += 1) {
    out.totals[i] += sourceTotals[i] ?? 0;
  }
  for (const [threshold, values] of Object.entries(source?.over ?? {})) {
    const bucket = out.over[threshold] ?? [0, 0, 0];
    out.over[threshold] = bucket;
    for (let i = 0; i < bucket.length; i += 1) {
      bucket[i] += values[i] ?? 0;
    }
  }
  return out;
}

function normalizeRawUsage(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const input = number(value.input_tokens);
  const cached = number(value.cached_input_tokens ?? value.cache_read_input_tokens);
  const output = number(value.output_tokens);
  const reasoning = number(value.reasoning_output_tokens);
  const total = number(value.total_tokens);
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total > 0 ? total : input + output,
  };
}

function cloneRawUsage(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return {
    input_tokens: number(value.input_tokens),
    cached_input_tokens: number(value.cached_input_tokens),
    output_tokens: number(value.output_tokens),
    reasoning_output_tokens: number(value.reasoning_output_tokens),
    total_tokens: number(value.total_tokens),
  };
}

function subtractRawUsage(current, previous) {
  return {
    input_tokens: Math.max(current.input_tokens - (previous?.input_tokens ?? 0), 0),
    cached_input_tokens: Math.max(current.cached_input_tokens - (previous?.cached_input_tokens ?? 0), 0),
    output_tokens: Math.max(current.output_tokens - (previous?.output_tokens ?? 0), 0),
    reasoning_output_tokens: Math.max(current.reasoning_output_tokens - (previous?.reasoning_output_tokens ?? 0), 0),
    total_tokens: Math.max(current.total_tokens - (previous?.total_tokens ?? 0), 0),
  };
}

function addRawUsage(previous, delta) {
  return {
    input_tokens: (previous?.input_tokens ?? 0) + delta.input_tokens,
    cached_input_tokens: (previous?.cached_input_tokens ?? 0) + delta.cached_input_tokens,
    output_tokens: (previous?.output_tokens ?? 0) + delta.output_tokens,
    reasoning_output_tokens: (previous?.reasoning_output_tokens ?? 0) + delta.reasoning_output_tokens,
    total_tokens: (previous?.total_tokens ?? 0) + delta.total_tokens,
  };
}

function extractModel(value, infoOverride = undefined) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const info = infoOverride ?? value.info;
  if (info && typeof info === 'object') {
    const direct = nonEmpty(info.model) ?? nonEmpty(info.model_name);
    if (direct) {
      return direct;
    }
    const metadataModel = extractMetadataModel(info.metadata);
    if (metadataModel) {
      return metadataModel;
    }
  }
  return nonEmpty(value.model) ?? extractMetadataModel(value.metadata);
}

function extractMetadataModel(metadata) {
  if (metadata && typeof metadata === 'object') {
    return nonEmpty(metadata.model);
  }
  return undefined;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function roundCost(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e12) / 1e12;
}

function roundRatio(value) {
  return Math.round(value * 1e6) / 1e6;
}

function usesTierPricing(price) {
  return billingThresholdsForPrice(price).length > 0;
}

function billingThresholdsForPrice(price) {
  const thresholds = new Set();
  if (Number.isFinite(price?.priorityExcludedAboveInputTokens) && price.priorityExcludedAboveInputTokens > 0) {
    thresholds.add(Math.trunc(price.priorityExcludedAboveInputTokens));
  }
  for (const tier of price?.tiered ?? []) {
    if (Number.isFinite(tier.thresholdTokens) && tier.thresholdTokens > 0) {
      thresholds.add(Math.trunc(tier.thresholdTokens));
    }
  }
  for (const tier of price?.priorityFallbackPrice?.tiered ?? []) {
    if (Number.isFinite(tier.thresholdTokens) && tier.thresholdTokens > 0) {
      thresholds.add(Math.trunc(tier.thresholdTokens));
    }
  }
  return [...thresholds].sort((a, b) => a - b);
}

function dedupeAliases(values) {
  const seen = new Set();
  const out = [];
  for (const item of values) {
    const key = `${item.model}\0${item.matchedModel}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out.sort((a, b) => a.model.localeCompare(b.model));
}
