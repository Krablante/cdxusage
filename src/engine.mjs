import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, opendir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import { resolveCodexDataPaths } from './codex-home.mjs';
import { calculateCostFromUsageOrEvents, loadPricingCatalog } from './pricing.mjs';

const CACHE_VERSION = 2;
const CACHE_SOURCE = 'cdxusage-index';
const DEFAULT_BILLING_THRESHOLDS = Object.freeze([128_000, 200_000, 256_000, 272_000]);
const TOKEN_NEEDLE = Buffer.from('token_count');
const TURN_NEEDLE = Buffer.from('turn_context');
const MODEL_RE = /"model"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/;
const FIND_FIELD_SEPARATOR = '\x1f';
const FIND_RECORD_SEPARATOR = '\x1e';
const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;

export function defaultCacheFile() {
  const root = process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache');
  return path.join(root, 'cdxusage', 'index-v2.json');
}

export async function collectUsage(options = {}) {
  const dataPaths = options.dataPaths ?? (await resolveCodexDataPaths(options));
  const codexHome = dataPaths.codexHome;
  const sessionsDir = dataPaths.sessionsDir;
  const timezone = safeTimeZone(options.timezone);
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

  for await (const discovered of discoverJsonlFiles(sessionsDir, { mode: discoveryMode, stats })) {
    const file = discovered.path;
    const st = discovered.stat ?? (await stat(file));
    stats.filesSeen += 1;
    stats.bytesSeen += st.size;

    const sessionInfo = makeSessionInfo(file, sessionsDir);
    const oldEntry = useCache ? cache.files[file] : undefined;
    let entry;

    if (oldEntry && sameFile(st, oldEntry)) {
      entry = oldEntry;
      stats.filesFromCache += 1;
      stats.bytesSkippedByCache += st.size;
    } else if (oldEntry && appendableFile(st, oldEntry)) {
      const tail = await scanFileRange(file, sessionInfo, timezone, oldEntry.size, oldEntry.state, billingThresholds);
      entry = finalizeCacheEntry(st, mergeEntries(oldEntry, tail), file);
      stats.filesScannedTail += 1;
      stats.bytesRead += tail.stats.bytesRead;
      stats.bytesSkippedByTailCache += oldEntry.size;
      addScanStats(stats, tail.stats);
    } else {
      const scan = await scanFileRange(file, sessionInfo, timezone, 0, undefined, billingThresholds);
      entry = finalizeCacheEntry(st, scan, file);
      stats.filesScannedFull += 1;
      stats.bytesRead += scan.stats.bytesRead;
      addScanStats(stats, scan.stats);
      if (oldEntry) {
        stats.filesCacheStale += 1;
      } else {
        stats.filesCacheMiss += 1;
      }
    }

    nextFiles[file] = entry;
    addEntryToAggregate(entry, aggregate, { since, until });
  }

  const report = buildReport(aggregate, stats, nextFiles);

  if (saveCache) {
    try {
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

export async function* discoverJsonlFiles(root, options = {}) {
  const mode = options.mode ?? 'auto';
  if (mode !== 'node') {
    let yielded = 0;
    try {
      for await (const entry of discoverJsonlFilesWithFind(root)) {
        options.stats.discoveryMode ??= 'find';
        yielded += 1;
        yield entry;
      }
      return;
    } catch (error) {
      if (mode === 'find' || yielded > 0) {
        throw error;
      }
      options.stats.discoveryMode ??= `node-fallback:${error.code ?? error.message}`;
    }
  }

  options.stats.discoveryMode ??= 'node';
  for await (const file of walkJsonl(root)) {
    yield { path: file };
  }
}

async function* discoverJsonlFilesWithFind(root) {
  try {
    await stat(root);
  } catch {
    return;
  }
  const child = spawn(
    'find',
    [
      root,
      '(',
      '-type',
      'f',
      '-name',
      '*.jsonl',
      '-printf',
      'f\\037%p\\037%D\\037%i\\037%s\\037%T@\\036',
      ')',
      '-o',
      '(',
      '-type',
      'l',
      '-name',
      '*.jsonl',
      '-xtype',
      'f',
      '-printf',
      'l\\037%p\\0370\\0370\\0370\\0370\\036',
      ')',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4096);
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  let buffer = '';
  for await (const chunk of child.stdout) {
    buffer += chunk.toString('utf8');
    for (;;) {
      const index = buffer.indexOf(FIND_RECORD_SEPARATOR);
      if (index === -1) {
        break;
      }
      const record = buffer.slice(0, index);
      buffer = buffer.slice(index + FIND_RECORD_SEPARATOR.length);
      const entry = parseFindRecord(record);
      if (entry) {
        yield entry;
      }
    }
  }
  if (buffer) {
    const entry = parseFindRecord(buffer);
    if (entry) {
      yield entry;
    }
  }
  const status = await closed;
  if (status.code !== 0) {
    throw new Error(`find exited with ${status.signal ?? status.code}: ${stderr.trim()}`);
  }
}

function parseFindRecord(record) {
  if (!record) {
    return null;
  }
  const parts = record.split(FIND_FIELD_SEPARATOR);
  if (parts.length !== 6 || !parts[1]) {
    return null;
  }
  const kind = parts[0];
  return {
    path: parts[1],
    stat:
      kind === 'f'
        ? {
            dev: Number(parts[2]),
            ino: Number(parts[3]),
            size: Number(parts[4]),
            mtimeMs: Number(parts[5]) * 1000,
          }
        : undefined,
  };
}

async function* walkJsonl(root) {
  let dir;
  try {
    dir = await opendir(root);
  } catch {
    return;
  }
  for await (const entry of dir) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonl(full);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      yield full;
    } else if (entry.isSymbolicLink() && entry.name.endsWith('.jsonl')) {
      try {
        if ((await stat(full)).isFile()) {
          yield full;
        }
      } catch {
        // Broken symlinks are not Codex session files.
      }
    }
  }
}

async function scanFileRange(file, sessionInfo, timezone, start = 0, initialState = undefined, billingThresholds = DEFAULT_BILLING_THRESHOLDS) {
  const dateFormatter = createDateKeyFormatter(timezone);
  const scan = {
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
      bytesRead: 0,
      linesSeen: 0,
      linesParsed: 0,
      tokenEvents: 0,
    },
  };
  let carry = Buffer.alloc(0);
  let lastByte;
  const stream = createReadStream(file, { start, highWaterMark: 1024 * 1024 });

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
      processLine(buf.subarray(lineStart, lineEnd), { scan, sessionInfo, dateFormatter, billingThresholds });
      lineStart = newline + 1;
    }
    carry = lineStart < buf.length ? Buffer.from(buf.subarray(lineStart)) : Buffer.alloc(0);
  }

  if (carry.length > 0) {
    processLine(carry, { scan, sessionInfo, dateFormatter, billingThresholds });
  }
  scan.endedWithNewline = scan.stats.bytesRead === 0 || lastByte === 10;
  return scan;
}

function processLine(line, context) {
  const { scan, sessionInfo, dateFormatter } = context;
  const billingThresholds = context.billingThresholds ?? DEFAULT_BILLING_THRESHOLDS;
  scan.stats.linesSeen += 1;
  if (line.length === 0) {
    return;
  }
  if (line.includes(TURN_NEEDLE)) {
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

  let entry;
  try {
    entry = JSON.parse(line.toString('utf8'));
  } catch {
    return;
  }
  scan.stats.linesParsed += 1;
  if (entry?.type !== 'event_msg' || entry?.payload?.type !== 'token_count' || !entry.timestamp) {
    return;
  }

  const info = entry.payload.info ?? {};
  const lastUsage = normalizeRawUsage(info.last_token_usage);
  const totalUsage = normalizeRawUsage(info.total_token_usage);
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

  const extractedModel = extractModel({ ...entry.payload, info });
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

  const date = toDateKey(entry.timestamp, dateFormatter);
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
    lastActivity: entry.timestamp,
    ...emptyUsage(),
    models: {},
  };
  sessionDay[sessionInfo.sessionId] = session;
  if (entry.timestamp > session.lastActivity) {
    session.lastActivity = entry.timestamp;
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
    .sort(([, a], [, b]) => a.lastActivity.localeCompare(b.lastActivity))
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
      const target = aggregate.sessions.get(sessionId) ?? {
        sessionId,
        sessionFile: session.sessionFile,
        directory: session.directory,
        lastActivity: session.lastActivity,
        ...emptyUsage(),
        models: {},
      };
      aggregate.sessions.set(sessionId, target);
      if (session.lastActivity > target.lastActivity) {
        target.lastActivity = session.lastActivity;
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
      linesParsed: (base.stats?.linesParsed ?? 0) + tail.stats.linesParsed,
      tokenEvents: (base.stats?.tokenEvents ?? 0) + tail.stats.tokenEvents,
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
    linesParsed: 0,
    tokenEvents: 0,
    bytesSeen: 0,
    bytesRead: 0,
    bytesSkippedByMtime: 0,
    bytesSkippedByPathDate: 0,
    bytesSkippedByCache: 0,
    bytesSkippedByTailCache: 0,
    cacheEntriesLoaded: Object.keys(cache.files).length,
    cacheEntriesSaved: 0,
    cacheSaveSkippedByError: false,
    cacheSaveError: null,
    discoveryMode: null,
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

function createDateKeyFormatter(timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: safeTimeZone(timezone),
  });
}

function toDateKey(timestamp, formatter) {
  return formatter.format(new Date(timestamp));
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
    await unlink(tmp).catch(() => {});
    if (error instanceof CacheTooLargeError) {
      stream.end();
      await finished(stream).catch(() => {});
      return { saved: false, bytes: error.bytes };
    }
    stream.destroy();
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
  target.linesSeen += scanStats.linesSeen;
  target.linesParsed += scanStats.linesParsed;
  target.tokenEvents += scanStats.tokenEvents;
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
  const modelSummary = {};
  addBillingSummary(modelSummary, 'row', model, delta, billingThresholds);
  session[model] = mergeBillingSummary(session[model], modelSummary.row[model]);
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

function extractModel(value) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const info = value.info;
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
