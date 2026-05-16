import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const MILLION = 1_000_000;
const PRICING_CACHE_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const OPENAI_PRICING_URL = 'https://developers.openai.com/api/docs/pricing';
const OPENAI_PRIORITY_PROCESSING_URL = 'https://developers.openai.com/api/docs/guides/priority-processing';
const DEFAULT_PRICING_CACHE_FILE = path.join(
  process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'),
  'cdxusage/pricing-v1.json',
);

const CODEX_MODEL_ALIASES = new Map([
  ['gpt-5-codex', 'gpt-5'],
  ['gpt-5.3-codex', 'gpt-5.2-codex'],
]);

const STANDARD_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;
const PRIORITY_LONG_CONTEXT_EXCLUSION_THRESHOLD_TOKENS = 128_000;
const STANDARD_LONG_CONTEXT_TIERS = new Map([
  ['gpt-5.5', standardLongContextTiers(10, 1, 45)],
  ['gpt-5.5-pro', standardLongContextTiers(60, 60, 270)],
  ['gpt-5.4', standardLongContextTiers(5, 0.5, 22.5)],
  ['gpt-5.4-pro', standardLongContextTiers(60, 60, 270)],
]);

const BUNDLED_STANDARD_PRICING = {
  'gpt-5.5': officialPrice(5, 0.5, 30),
  'gpt-5.5-pro': officialPrice(30, null, 180),
  'gpt-5.4': officialPrice(2.5, 0.25, 15),
  'gpt-5.4-mini': officialPrice(0.75, 0.075, 4.5),
  'gpt-5.4-nano': officialPrice(0.2, 0.02, 1.25),
  'gpt-5.4-pro': officialPrice(30, null, 180),
  'gpt-5.2': officialPrice(1.75, 0.175, 14),
  'gpt-5.2-codex': officialPrice(1.75, 0.175, 14),
  'gpt-5.3-codex': officialPrice(1.75, 0.175, 14),
  'gpt-5.1': officialPrice(1.25, 0.125, 10),
  'gpt-5.1-codex': officialPrice(1.25, 0.125, 10),
  'gpt-5-codex': officialPrice(1.25, 0.125, 10),
  'gpt-5': officialPrice(1.25, 0.125, 10),
  'gpt-5-mini': officialPrice(0.25, 0.025, 2),
  'gpt-5-nano': officialPrice(0.05, 0.005, 0.4),
  'gpt-4.1': officialPrice(2, 0.5, 8),
  'gpt-4.1-mini': officialPrice(0.4, 0.1, 1.6),
  'gpt-4.1-nano': officialPrice(0.1, 0.025, 0.4),
  'gpt-4o': officialPrice(2.5, 1.25, 10),
  'gpt-4o-2024-11-20': officialPrice(2.5, 1.25, 10),
  'gpt-4o-2024-08-06': officialPrice(2.5, 1.25, 10),
  'gpt-4o-2024-05-13': officialPrice(5, 5, 15),
  'gpt-4o-mini': officialPrice(0.15, 0.075, 0.6),
  o3: officialPrice(2, 0.5, 8),
  'o4-mini': officialPrice(1.1, 0.275, 4.4),
};

const BUNDLED_PRIORITY_PRICING = {
  'gpt-5.5': officialPriorityPrice(12.5, 1.25, 75),
  'gpt-5.4': officialPriorityPrice(5, 0.5, 30),
  'gpt-5.4-mini': officialPriorityPrice(1.5, 0.15, 9),
  'gpt-5.2': officialPriorityPrice(3.5, 0.35, 28),
  'gpt-5.2-codex': officialPriorityPrice(3.5, 0.35, 28),
  'gpt-5.3-codex': officialPriorityPrice(3.5, 0.35, 28),
  'gpt-5.1': officialPriorityPrice(2.5, 0.25, 20),
  'gpt-5.1-codex': officialPriorityPrice(2.5, 0.25, 20),
  'gpt-5-codex': officialPriorityPrice(2.5, 0.25, 20),
  'gpt-5': officialPriorityPrice(2.5, 0.25, 20),
  'gpt-5-mini': officialPriorityPrice(0.45, 0.045, 3.6),
  'gpt-4.1': officialPriorityPrice(3.5, 0.875, 14),
  'gpt-4.1-mini': officialPriorityPrice(0.7, 0.175, 2.8),
  'gpt-4.1-nano': officialPriorityPrice(0.2, 0.05, 0.8),
  'gpt-4o': officialPriorityPrice(4.25, 2.125, 17),
  'gpt-4o-2024-11-20': officialPriorityPrice(4.25, 2.125, 17),
  'gpt-4o-2024-08-06': officialPriorityPrice(4.25, 2.125, 17),
  'gpt-4o-2024-05-13': officialPriorityPrice(8.75, 8.75, 26.25),
  'gpt-4o-mini': officialPriorityPrice(0.25, 0.125, 1),
  o3: officialPriorityPrice(3.5, 0.875, 14),
  'o4-mini': officialPriorityPrice(2, 0.5, 8),
};

export async function loadPricingCatalog(options = {}) {
  const tier = options.tier ?? 'standard';
  const priorityModels = tier === 'priority' ? normalizePriorityModels(options.priorityModels) : null;
  const cacheFile = options.cacheFile ?? DEFAULT_PRICING_CACHE_FILE;
  const ttlMs = Math.max(0, Number(options.ttlMs ?? DEFAULT_TTL_MS));
  const offline = Boolean(options.offline);

  if (options.pricingData) {
    const data = normalizePricingDataForTier(options.pricingData, {
      source: 'injected',
      sourceUrl: 'in-memory fixture',
      tier,
      priorityModels,
    });
    return createCatalog(data, {
      source: 'injected',
      sourceUrl: 'in-memory fixture',
      fetchedAt: new Date(0).toISOString(),
      cacheFile: null,
      cacheState: 'disabled',
      ttlHours: ttlMs / 3_600_000,
      modelCount: Object.keys(data).length,
      tier,
      priorityModels,
    });
  }

  const cached = await readPricingCache(cacheFile);
  const cachedForTier =
    cached && (cached.tier ?? 'standard') === tier && samePriorityModels(cached.priorityModels ?? null, priorityModels)
      ? cached
      : null;
  const cacheTierMismatch = Boolean(cached && !cachedForTier);
  if (offline) {
    const source = cachedForTier?.data ?? bundledPricingData(tier, { priorityModels });
    return createCatalog(source, {
      source: cachedForTier ? cachedForTier.source : bundledSourceName(tier),
      sourceUrl: cachedForTier ? cachedForTier.sourceUrl : bundledSourceUrl(tier),
      fetchedAt: cachedForTier?.fetchedAt ?? new Date(0).toISOString(),
      cacheFile,
      cacheState: cachedForTier ? 'offline-cache' : cacheTierMismatch ? 'offline-cache-tier-mismatch-bundled' : 'offline-bundled',
      ttlHours: ttlMs / 3_600_000,
      modelCount: Object.keys(source).length,
      tier,
      priorityModels,
    });
  }

  if (cachedForTier && Date.now() - Date.parse(cachedForTier.fetchedAt) <= ttlMs) {
    return createCatalog(cachedForTier.data, {
      source: cachedForTier.source,
      sourceUrl: cachedForTier.sourceUrl,
      fetchedAt: cachedForTier.fetchedAt,
      cacheFile,
      cacheState: 'fresh',
      ttlHours: ttlMs / 3_600_000,
      modelCount: Object.keys(cachedForTier.data).length,
      tier,
      priorityModels,
    });
  }

  try {
    const fetched = await fetchLivePricing({ tier, timeoutMs: options.fetchTimeoutMs, priorityModels });
    await savePricingCache(cacheFile, fetched);
    return createCatalog(fetched.data, {
      source: fetched.source,
      sourceUrl: fetched.sourceUrl,
      fetchedAt: fetched.fetchedAt,
      cacheFile,
      cacheState: cached ? 'refreshed' : 'created',
      ttlHours: ttlMs / 3_600_000,
      modelCount: Object.keys(fetched.data).length,
      tier,
      priorityModels,
    });
  } catch (error) {
    const source = cachedForTier?.data ?? bundledPricingData(tier, { priorityModels });
    return createCatalog(source, {
      source: cachedForTier ? cachedForTier.source : bundledSourceName(tier),
      sourceUrl: cachedForTier ? cachedForTier.sourceUrl : bundledSourceUrl(tier),
      fetchedAt: cachedForTier?.fetchedAt ?? new Date(0).toISOString(),
      cacheFile,
      cacheState: cachedForTier ? 'stale-after-fetch-failure' : 'bundled-after-fetch-failure',
      ttlHours: ttlMs / 3_600_000,
      modelCount: Object.keys(source).length,
      tier,
      priorityModels,
      fetchError: error?.message,
    });
  }
}

export function parseOpenAIDevPricingHtml(html, options = {}) {
  const tier = options.tier ?? 'standard';
  const out = {};
  const components = extractAstroComponents(html);

  for (const component of components) {
    if (component.exportName === 'TextTokenPricingTables') {
      const componentTier = readAstroStringField(component.props, 'tier');
      if (componentTier !== tier) {
        continue;
      }
      addRowsFromProps(component.props, out, tier === 'priority' ? 'openai-priority-official' : 'openai-official');
    }
  }

  for (const component of components) {
    if (component.exportName !== 'GroupedPricingTable') {
      continue;
    }
    if ((component.pane ?? (tier === 'standard' ? 'standard' : null)) !== tier) {
      continue;
    }
    if (!isTokenGroupedPricingTable(component.props)) {
      continue;
    }
    addRowsFromProps(component.props, out, tier === 'priority' ? 'openai-priority-official' : 'openai-official');
  }

  for (const [model, price] of Object.entries(out)) {
    price.serviceTier = tier;
    price.tierAdjusted = tier !== 'standard';
    addKnownStandardLongContextTiers(model, price);
  }
  return out;
}

export function calculateCostUSD(usage, price) {
  const inputTokens = finiteNumber(usage.inputTokens);
  const cachedInputTokens = Math.min(finiteNumber(usage.cachedInputTokens), inputTokens);
  const outputTokens = finiteNumber(usage.outputTokens);
  if (requiresEventPricing(price)) {
    return calculateEventCostUSD([inputTokens, cachedInputTokens, outputTokens], price);
  }
  const nonCachedInputTokens = Math.max(inputTokens - cachedInputTokens, 0);

  return (
    (nonCachedInputTokens / MILLION) * price.inputCostPerMToken +
    (cachedInputTokens / MILLION) * price.cachedInputCostPerMToken +
    (outputTokens / MILLION) * price.outputCostPerMToken
  );
}

export function calculateCostFromUsageOrEvents(usage, price, events) {
  if (!events || (Array.isArray(events) && events.length === 0)) {
    return calculateCostUSD(usage, price);
  }
  if (!Array.isArray(events)) {
    return calculateCostFromBillingSummary(usage, price, events);
  }

  let cost = 0;
  for (const event of events) {
    cost += calculateEventCostUSD(event, price);
  }
  return cost;
}

function calculateCostFromBillingSummary(usage, price, summary) {
  if (!summary || !Array.isArray(summary.totals)) {
    return calculateCostUSD(usage, price);
  }
  if (hasPriorityFallback(price)) {
    const threshold = price.priorityExcludedAboveInputTokens;
    const excluded = summary.over?.[threshold];
    if (Array.isArray(excluded)) {
      const included = summary.totals.map((value, index) => Math.max(finiteNumber(value) - finiteNumber(excluded[index]), 0));
      const priorityCost = calculateSummaryCost({ totals: included, over: summary.over }, price);
      const fallbackCost = calculateSummaryCost({ totals: excluded, over: summary.over }, price.priorityFallbackPrice);
      if (priorityCost != null && fallbackCost != null) {
        return priorityCost + fallbackCost;
      }
    }
  }
  const cost = calculateSummaryCost(summary, price);
  if (cost == null) {
    return calculateCostUSD(usage, price);
  }
  return cost;
}

function calculateSummaryCost(summary, price) {
  const inputCost = calculateTieredTokenCostFromSummary(
    finiteNumber(summary.totals[0]),
    summary,
    0,
    price.inputCostPerMToken,
    price.tiered,
    'input_cost_per_token',
  );
  const cachedCost = calculateTieredTokenCostFromSummary(
    finiteNumber(summary.totals[1]),
    summary,
    1,
    price.cachedInputCostPerMToken,
    price.tiered,
    'cache_read_input_token_cost',
  );
  const outputCost = calculateTieredTokenCostFromSummary(
    finiteNumber(summary.totals[2]),
    summary,
    2,
    price.outputCostPerMToken,
    price.tiered,
    'output_cost_per_token',
  );
  if (inputCost == null || cachedCost == null || outputCost == null) {
    return null;
  }
  return inputCost + cachedCost + outputCost;
}

function calculateEventCostUSD(event, price) {
  const inputTokens = finiteNumber(event[0]);
  const cachedInputTokens = Math.min(finiteNumber(event[1]), inputTokens);
  if (shouldUsePriorityFallback(inputTokens, price)) {
    return calculateEventCostUSD([inputTokens, cachedInputTokens, event[2]], price.priorityFallbackPrice);
  }
  const nonCachedInputTokens = Math.max(inputTokens - cachedInputTokens, 0);
  const outputTokens = finiteNumber(event[2]);
  const summary = {
    over: Object.fromEntries(
      tierThresholds(price.tiered).map((threshold) => [
        threshold,
        contextOverThreshold(inputTokens, cachedInputTokens, outputTokens, threshold),
      ]),
    ),
  };

  return (
    calculateTieredTokenCostFromSummary(
      nonCachedInputTokens,
      summary,
      0,
      price.inputCostPerMToken,
      price.tiered,
      'input_cost_per_token',
    ) +
    calculateTieredTokenCostFromSummary(
      cachedInputTokens,
      summary,
      1,
      price.cachedInputCostPerMToken,
      price.tiered,
      'cache_read_input_token_cost',
    ) +
    calculateTieredTokenCostFromSummary(
      outputTokens,
      summary,
      2,
      price.outputCostPerMToken,
      price.tiered,
      'output_cost_per_token',
    )
  );
}

function calculateTieredTokenCostFromSummary(totalTokens, summary, index, baseCostPerMToken, tiers, kind) {
  const total = finiteNumber(totalTokens);
  if (total <= 0) {
    return 0;
  }
  const matchingTiers = (tiers ?? [])
    .filter((tier) => tier.kind === kind)
    .sort((a, b) => a.thresholdTokens - b.thresholdTokens);
  let cost = (total / MILLION) * baseCostPerMToken;
  let previousRate = baseCostPerMToken;
  for (const tier of matchingTiers) {
    const overTokens = summary.over?.[tier.thresholdTokens]?.[index];
    if (typeof overTokens !== 'number') {
      return null;
    }
    cost += (overTokens / MILLION) * (tier.costPerMToken - previousRate);
    previousRate = tier.costPerMToken;
  }
  return cost;
}

function tierThresholds(tiers) {
  return [...new Set((tiers ?? []).map((tier) => tier.thresholdTokens).filter((value) => Number.isFinite(value)))].sort(
    (a, b) => a - b,
  );
}

function hasPriorityFallback(price) {
  return Number.isFinite(price?.priorityExcludedAboveInputTokens) && price.priorityFallbackPrice;
}

function shouldUsePriorityFallback(inputTokens, price) {
  return hasPriorityFallback(price) && finiteNumber(inputTokens) > price.priorityExcludedAboveInputTokens;
}

function requiresEventPricing(price) {
  return hasPriorityFallback(price) || (Array.isArray(price?.tiered) && price.tiered.length > 0);
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

async function fetchLivePricing(options) {
  const tier = options.tier ?? 'standard';
  const priorityModels = tier === 'priority' ? normalizePriorityModels(options.priorityModels) : null;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const [openai, openaiPriority] = await Promise.allSettled([
    fetchOpenAIOfficialPricing({ tier: 'standard', timeoutMs }),
    tier === 'priority' ? fetchOpenAIOfficialPricing({ tier: 'priority', timeoutMs }) : Promise.resolve(null),
  ]);

  const data = normalizeRawPricingData(BUNDLED_STANDARD_PRICING, bundledMetadata('standard'));
  const sources = ['openai-official-bundled'];
  const urls = [OPENAI_PRICING_URL];

  if (openai.status === 'fulfilled') {
    mergePricingData(data, openai.value);
    sources.push('openai-official');
    urls.push(OPENAI_PRICING_URL);
  }
  if (tier === 'priority') {
    const bundledPriority = filterPricingDataByModels(
      normalizeRawPricingData(BUNDLED_PRIORITY_PRICING, priorityBundledMetadata()),
      priorityModels,
    );
    mergePricingData(data, bundledPriority);
    if (Object.keys(bundledPriority).length > 0) {
      sources.push('openai-priority-official-bundled');
      urls.push(OPENAI_PRIORITY_PROCESSING_URL);
    }
    if (openaiPriority.status === 'fulfilled') {
      const scopedOpenAiPriority = filterPricingDataByModels(openaiPriority.value, priorityModels);
      mergePricingData(data, scopedOpenAiPriority);
      if (Object.keys(scopedOpenAiPriority).length > 0) {
        sources.push('openai-priority-official');
        urls.push(OPENAI_PRICING_URL);
      }
    }
  }
  const liveResults = tier === 'priority' ? [openai, openaiPriority] : [openai];
  if (liveResults.every((result) => result.status === 'rejected')) {
    throw new Error(`pricing fetch failed: ${openai.reason?.message}; ${openaiPriority.reason?.message}`);
  }

  return {
    version: PRICING_CACHE_VERSION,
    source: sources.join('+'),
    sourceUrl: [...new Set(urls)].join(' + '),
    fetchedAt: new Date().toISOString(),
    tier,
    priorityModels,
    data,
  };
}

async function fetchOpenAIOfficialPricing(options) {
  const html = await fetchText(OPENAI_PRICING_URL, options.timeoutMs);
  const parsed = parseOpenAIDevPricingHtml(html, { tier: options.tier });
  if (Object.keys(parsed).length === 0) {
    throw new Error('OpenAI pricing page did not expose parseable token rows');
  }
  return parsed;
}

function createCatalog(data, metadata) {
  const catalogData = withKnownPricingAdjustments(data);
  const exact = new Map();
  for (const [model, price] of Object.entries(catalogData)) {
    exact.set(normalizeKey(model), { model, price });
  }

  return {
    metadata: {
      ...metadata,
      billingThresholds: pricingBillingThresholds(catalogData),
    },
    getPricing(model) {
      const candidates = createModelCandidates(model);
      for (const candidate of candidates) {
        const found = exact.get(normalizeKey(candidate));
        if (!found || !hasNonZeroPrice(found.price)) {
          continue;
        }
        return {
          price: found.price,
          missing: false,
          free: false,
          detail: pricingDetail(model, found.model, found.price),
        };
      }

      return {
        price: missingPrice(),
        missing: true,
        free: false,
        detail: {
          requestedModel: model,
          matchedModel: null,
          source: null,
          sourceUrl: null,
          inputCostPerMToken: 0,
          cachedInputCostPerMToken: 0,
          outputCostPerMToken: 0,
        },
      };
    },
  };
}

function withKnownPricingAdjustments(data) {
  const out = {};
  for (const [model, price] of Object.entries(data ?? {})) {
    const adjusted = {
      ...price,
      tiered: Array.isArray(price?.tiered) ? price.tiered.map((tier) => ({ ...tier })) : undefined,
      priorityFallbackPrice: cloneFallbackPrice(price?.priorityFallbackPrice),
    };
    addKnownStandardLongContextTiers(model, adjusted);
    addKnownPriorityExclusionFallback(model, adjusted);
    out[model] = adjusted;
  }
  return out;
}

function cloneFallbackPrice(price) {
  if (!price || typeof price !== 'object') {
    return null;
  }
  const cloned = {
    ...price,
    tiered: Array.isArray(price.tiered) ? price.tiered.map((tier) => ({ ...tier })) : undefined,
  };
  delete cloned.priorityExcludedAboveInputTokens;
  delete cloned.priorityFallbackPrice;
  return cloned;
}

function addKnownPriorityExclusionFallback(model, price) {
  if (!model || !price?.tierAdjusted) {
    return;
  }
  price.priorityExcludedAboveInputTokens ??= PRIORITY_LONG_CONTEXT_EXCLUSION_THRESHOLD_TOKENS;
  price.priorityFallbackPrice ??= bundledStandardFallbackPrice(model);
}

function pricingBillingThresholds(data) {
  const thresholds = new Set();
  for (const price of Object.values(data ?? {})) {
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
  }
  return [...thresholds].sort((a, b) => a - b);
}

function mergePricingData(target, source) {
  for (const [model, price] of Object.entries(source)) {
    const existing = target[model];
    if (existing?.tierAdjusted && price.serviceTier !== 'standard' && !price.tierAdjusted) {
      continue;
    }
    const inheritedTiered = price.tierAdjusted ? undefined : existing?.tiered;
    const priorityFallbackPrice = price.tierAdjusted
      ? cloneFallbackPrice(existing?.tierAdjusted ? existing.priorityFallbackPrice : existing)
      : price.priorityFallbackPrice;
    target[model] = {
      ...price,
      tiered: price.tiered ?? inheritedTiered,
      priorityExcludedAboveInputTokens: price.tierAdjusted
        ? PRIORITY_LONG_CONTEXT_EXCLUSION_THRESHOLD_TOKENS
        : price.priorityExcludedAboveInputTokens,
      priorityFallbackPrice,
    };
  }
}

function filterPricingDataByModels(data, priorityModels) {
  if (priorityModels == null) {
    return data;
  }
  const scope = new Set(priorityModels);
  const out = {};
  for (const [model, price] of Object.entries(data)) {
    if (modelMatchesPriorityScope(model, scope)) {
      out[model] = price;
    }
  }
  return out;
}

function modelMatchesPriorityScope(model, scope) {
  return createModelCandidates(model).some((candidate) => scope.has(normalizeKey(candidate)));
}

function normalizePriorityModels(priorityModels) {
  if (priorityModels == null) {
    return null;
  }
  const raw = Array.isArray(priorityModels) ? priorityModels : String(priorityModels).split(',');
  const normalized = raw
    .map((model) => String(model).trim())
    .filter(Boolean)
    .map((model) => model.toLowerCase() === 'all' ? 'all' : normalizeKey(normalizeModelName(model)));
  if (normalized.includes('all')) {
    return null;
  }
  return [...new Set(normalized)].sort();
}

function samePriorityModels(left, right) {
  const normalizedLeft = normalizePriorityModels(left);
  const normalizedRight = normalizePriorityModels(right);
  if (normalizedLeft == null || normalizedRight == null) {
    return normalizedLeft == null && normalizedRight == null;
  }
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((model, index) => model === normalizedRight[index])
  );
}

function createModelCandidates(model) {
  const normalized = normalizeModelName(model);
  const candidates = new Set([model, normalized]);

  const alias = CODEX_MODEL_ALIASES.get(normalized);
  if (alias) {
    candidates.add(alias);
  }

  if (normalized.startsWith('openai/')) {
    candidates.add(normalized.slice('openai/'.length));
  }
  if (/^gpt-\d/.test(normalized) && normalized.endsWith('-codex')) {
    candidates.add(normalized.slice(0, -'-codex'.length));
  }

  return [...candidates].filter(Boolean);
}

function normalizeRawPricingData(raw, defaults) {
  const out = {};
  for (const [model, value] of Object.entries(raw ?? {})) {
    const normalizedModel = normalizeModelName(model);
    const price = normalizePrice(value, {
      source: value?.sourceName ?? value?.source ?? defaults.source,
      sourceUrl: value?.sourceUrl ?? defaults.sourceUrl,
      tier: defaults.tier,
    }, normalizedModel);
    if (!price) {
      continue;
    }
    out[normalizedModel] = price;
  }
  return out;
}

function normalizePrice(value, metadata, model) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const serviceTier = metadata.tier ?? 'standard';
  const rangePricing = parseTieredPricingRanges(value.tiered_pricing, serviceTier);
  const tieredInput = perTokenToPerMillion(value[`input_cost_per_token_${serviceTier}`]);
  const tieredOutput = perTokenToPerMillion(value[`output_cost_per_token_${serviceTier}`]);
  const tieredCached = perTokenToPerMillion(value[`cache_read_input_token_cost_${serviceTier}`]);
  const tierAdjusted = serviceTier !== 'standard' && [tieredInput, tieredOutput, tieredCached].some((item) => item != null);

  const inputPerM = firstFinite(
    tieredInput,
    value.inputCostPerMToken,
    perTokenToPerMillion(value.input_cost_per_token),
    rangePricing.base.inputCostPerMToken,
  );
  const outputPerM = firstFinite(
    tieredOutput,
    value.outputCostPerMToken,
    perTokenToPerMillion(value.output_cost_per_token),
    rangePricing.base.outputCostPerMToken,
  );
  const cachedPerM = firstFinite(
    tieredCached,
    value.cachedInputCostPerMToken,
    perTokenToPerMillion(value.cache_read_input_token_cost),
    rangePricing.base.cachedInputCostPerMToken,
    inputPerM,
  );

  if (inputPerM == null && outputPerM == null && cachedPerM == null) {
    return null;
  }

  const price = {
    inputCostPerMToken: inputPerM ?? 0,
    cachedInputCostPerMToken: cachedPerM ?? inputPerM ?? 0,
    outputCostPerMToken: outputPerM ?? 0,
    source: value.sourceName ?? metadata.source,
    sourceUrl: value.sourceUrl ?? metadata.sourceUrl,
    serviceTier,
    tierAdjusted,
  };

  for (const tier of rangePricing.tiers) {
    price.tiered ??= [];
    price.tiered.push({
      kind: tier.kind,
      thresholdTokens: tier.thresholdTokens,
      costPerMToken: tier.costPerMToken,
    });
  }

  if (Array.isArray(value.tiered)) {
    for (const tier of value.tiered) {
      if (
        typeof tier?.kind !== 'string' ||
        typeof tier.thresholdTokens !== 'number' ||
        typeof tier.costPerMToken !== 'number'
      ) {
        continue;
      }
      price.tiered ??= [];
      price.tiered.push({
        kind: tier.kind,
        thresholdTokens: tier.thresholdTokens,
        costPerMToken: tier.costPerMToken,
      });
    }
  }

  for (const [key, rawValue] of Object.entries(value)) {
    const match = key.match(/^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost)_above_(\d+)k_tokens$/);
    if (!match || typeof rawValue !== 'number') {
      continue;
    }
    price.tiered ??= [];
    price.tiered.push({
      kind: match[1],
      thresholdTokens: Number(match[2]) * 1000,
      costPerMToken: rawValue * MILLION,
    });
  }

  addKnownStandardLongContextTiers(model, price);
  return price;
}

function parseTieredPricingRanges(raw, serviceTier) {
  const parsed = { base: {}, tiers: [] };
  if (!Array.isArray(raw)) {
    return parsed;
  }
  for (const item of raw) {
    if (!item || typeof item !== 'object' || !Array.isArray(item.range)) {
      continue;
    }
    const start = Number(item.range[0]);
    if (!Number.isFinite(start) || start < 0) {
      continue;
    }
    const rates = {
      inputCostPerMToken: perTokenToPerMillion(item[`input_cost_per_token_${serviceTier}`] ?? item.input_cost_per_token),
      cachedInputCostPerMToken: perTokenToPerMillion(
        item[`cache_read_input_token_cost_${serviceTier}`] ?? item.cache_read_input_token_cost,
      ),
      outputCostPerMToken: perTokenToPerMillion(item[`output_cost_per_token_${serviceTier}`] ?? item.output_cost_per_token),
    };
    if (start === 0) {
      parsed.base = {
        inputCostPerMToken: rates.inputCostPerMToken,
        cachedInputCostPerMToken: rates.cachedInputCostPerMToken,
        outputCostPerMToken: rates.outputCostPerMToken,
      };
      continue;
    }
    addRangeTier(parsed.tiers, 'input_cost_per_token', start, rates.inputCostPerMToken);
    addRangeTier(parsed.tiers, 'cache_read_input_token_cost', start, rates.cachedInputCostPerMToken);
    addRangeTier(parsed.tiers, 'output_cost_per_token', start, rates.outputCostPerMToken);
  }
  return parsed;
}

function addRangeTier(target, kind, thresholdTokens, costPerMToken) {
  if (typeof costPerMToken !== 'number' || !Number.isFinite(costPerMToken)) {
    return;
  }
  target.push({
    kind,
    thresholdTokens: Math.trunc(thresholdTokens),
    costPerMToken,
  });
}

function officialPrice(inputCostPerMToken, cachedInputCostPerMToken, outputCostPerMToken) {
  return {
    inputCostPerMToken,
    cachedInputCostPerMToken: cachedInputCostPerMToken ?? inputCostPerMToken,
    outputCostPerMToken,
    sourceName: 'openai-official-bundled',
    sourceUrl: OPENAI_PRICING_URL,
  };
}

function officialPriorityPrice(inputCostPerMToken, cachedInputCostPerMToken, outputCostPerMToken) {
  return {
    input_cost_per_token_priority: inputCostPerMToken / MILLION,
    cache_read_input_token_cost_priority: (cachedInputCostPerMToken ?? inputCostPerMToken) / MILLION,
    output_cost_per_token_priority: outputCostPerMToken / MILLION,
    sourceName: 'openai-priority-official-bundled',
    sourceUrl: OPENAI_PRIORITY_PROCESSING_URL,
  };
}

function standardLongContextTiers(inputCostPerMToken, cachedInputCostPerMToken, outputCostPerMToken) {
  return [
    {
      kind: 'input_cost_per_token',
      thresholdTokens: STANDARD_LONG_CONTEXT_THRESHOLD_TOKENS,
      costPerMToken: inputCostPerMToken,
    },
    {
      kind: 'cache_read_input_token_cost',
      thresholdTokens: STANDARD_LONG_CONTEXT_THRESHOLD_TOKENS,
      costPerMToken: cachedInputCostPerMToken,
    },
    {
      kind: 'output_cost_per_token',
      thresholdTokens: STANDARD_LONG_CONTEXT_THRESHOLD_TOKENS,
      costPerMToken: outputCostPerMToken,
    },
  ];
}

function addKnownStandardLongContextTiers(model, price) {
  if (!model || price?.serviceTier !== 'standard' || !String(price.source ?? '').startsWith('openai-official')) {
    return;
  }
  const tiers = STANDARD_LONG_CONTEXT_TIERS.get(normalizeModelName(model));
  if (!tiers) {
    return;
  }
  const existing = new Set((price.tiered ?? []).map((tier) => `${tier.kind}:${tier.thresholdTokens}`));
  for (const tier of tiers) {
    const key = `${tier.kind}:${tier.thresholdTokens}`;
    if (existing.has(key)) {
      continue;
    }
    price.tiered ??= [];
    price.tiered.push({ ...tier });
    existing.add(key);
  }
}

function bundledStandardFallbackPrice(model) {
  const normalized = normalizeModelName(model);
  const raw = BUNDLED_STANDARD_PRICING[normalized];
  if (!raw) {
    return null;
  }
  return normalizePrice(raw, bundledMetadata('standard'), normalized);
}

function bundledMetadata(tier) {
  return {
    source: 'openai-official-bundled',
    sourceUrl: OPENAI_PRICING_URL,
    tier,
  };
}

function bundledPricingData(tier, options = {}) {
  const data = normalizeRawPricingData(BUNDLED_STANDARD_PRICING, bundledMetadata('standard'));
  if (tier === 'priority') {
    const priorityModels = normalizePriorityModels(options.priorityModels);
    mergePricingData(
      data,
      filterPricingDataByModels(normalizeRawPricingData(BUNDLED_PRIORITY_PRICING, priorityBundledMetadata()), priorityModels),
    );
  }
  return data;
}

function normalizePricingDataForTier(raw, defaults) {
  const tier = defaults.tier ?? 'standard';
  const base = normalizeRawPricingData(raw, { ...defaults, tier: 'standard' });
  if (tier !== 'priority') {
    return base;
  }
  const priority = filterPricingDataByModels(
    normalizeRawPricingData(raw, { ...defaults, tier: 'priority' }),
    normalizePriorityModels(defaults.priorityModels),
  );
  mergePricingData(base, priority);
  return base;
}

function priorityBundledMetadata() {
  return {
    source: 'openai-priority-official-bundled',
    sourceUrl: OPENAI_PRIORITY_PROCESSING_URL,
    tier: 'priority',
  };
}

function bundledSourceName(tier) {
  return tier === 'priority' ? 'openai-official-bundled+openai-priority-official-bundled' : 'openai-official-bundled';
}

function bundledSourceUrl(tier) {
  return tier === 'priority' ? `${OPENAI_PRICING_URL} + ${OPENAI_PRIORITY_PROCESSING_URL}` : OPENAI_PRICING_URL;
}

function addRowsFromProps(props, out, sourceName) {
  const rowRe = /\[0,"([^"]+)"\],\[0,(-?\d+(?:\.\d+)?|null|""|"-"|"Free")\],\[0,(-?\d+(?:\.\d+)?|null|""|"-")\],\[0,(-?\d+(?:\.\d+)?|null|""|"-")\]/g;
  for (const match of props.matchAll(rowRe)) {
    const model = normalizeOfficialModelName(match[1]);
    if (!model) {
      continue;
    }
    const input = parseAstroNumber(match[2]);
    const cached = parseAstroNumber(match[3]);
    const output = parseAstroNumber(match[4]);
    if (input == null && output == null) {
      continue;
    }
    out[model] = {
      inputCostPerMToken: input ?? 0,
      cachedInputCostPerMToken: cached ?? input ?? 0,
      outputCostPerMToken: output ?? 0,
      source: sourceName,
      sourceUrl: OPENAI_PRICING_URL,
    };
  }
}

function extractAstroComponents(html) {
  const components = [];
  const re = /component-export="([^"]+)"[^>]*props="([^"]+)"/g;
  for (const match of html.matchAll(re)) {
    const prefix = html.slice(Math.max(0, match.index - 5000), match.index);
    const paneMatches = [...prefix.matchAll(/data-content-switcher-pane="true"\s+data-value="([^"]+)"/g)];
    components.push({
      exportName: match[1],
      props: decodeHtmlAttribute(match[2]),
      pane: paneMatches.at(-1)?.[1] ?? null,
    });
  }
  return components;
}

function isTokenGroupedPricingTable(props) {
  return (
    props.includes('"Category"') &&
    props.includes('"Model"') &&
    props.includes('"Input"') &&
    props.includes('"Cached input"') &&
    props.includes('"Output"')
  );
}

function readAstroStringField(props, field) {
  const match = props.match(new RegExp(`"${escapeRegex(field)}":\\[0,"([^"]+)"\\]`));
  return match?.[1];
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function normalizeOfficialModelName(value) {
  return normalizeModelName(value.replace(/\s*\(<[^)]*\)\s*$/u, '').replace(/\s*\([^)]*\)\s*$/u, ''));
}

function parseAstroNumber(value) {
  if (value === 'null' || value === '""' || value === '"-"' || value === '"Free"') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { accept: 'text/html, text/markdown;q=0.9, */*;q=0.5' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function readPricingCache(cacheFile) {
  try {
    const parsed = JSON.parse(await readFile(cacheFile, 'utf8'));
    if (parsed?.version === PRICING_CACHE_VERSION && parsed.data && typeof parsed.data === 'object') {
      return parsed;
    }
  } catch {
    // Cache miss or corrupt cache falls back to live/bundled pricing.
  }
  return null;
}

async function savePricingCache(cacheFile, fetched) {
  await mkdir(path.dirname(cacheFile), { recursive: true });
  const tmp = `${cacheFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(fetched)}\n`);
    await rename(tmp, cacheFile);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

function pricingDetail(requestedModel, matchedModel, price, overrides = {}) {
  const detail = {
    requestedModel,
    matchedModel,
    source: overrides.source ?? price.source ?? null,
    sourceUrl: overrides.sourceUrl ?? price.sourceUrl ?? null,
    inputCostPerMToken: price.inputCostPerMToken,
    cachedInputCostPerMToken: price.cachedInputCostPerMToken,
    outputCostPerMToken: price.outputCostPerMToken,
  };
  if (price.tiered?.length > 0) {
    detail.tiered = price.tiered
      .map((tier) => ({
        kind: tier.kind,
        thresholdTokens: tier.thresholdTokens,
        costPerMToken: tier.costPerMToken,
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.thresholdTokens - b.thresholdTokens);
  }
  if (Number.isFinite(price.priorityExcludedAboveInputTokens) && price.priorityFallbackPrice) {
    detail.priorityExcludedAboveInputTokens = price.priorityExcludedAboveInputTokens;
    detail.priorityFallback = {
      source: price.priorityFallbackPrice.source ?? null,
      sourceUrl: price.priorityFallbackPrice.sourceUrl ?? null,
      inputCostPerMToken: price.priorityFallbackPrice.inputCostPerMToken,
      cachedInputCostPerMToken: price.priorityFallbackPrice.cachedInputCostPerMToken,
      outputCostPerMToken: price.priorityFallbackPrice.outputCostPerMToken,
    };
    if (price.priorityFallbackPrice.tiered?.length > 0) {
      detail.priorityFallback.tiered = price.priorityFallbackPrice.tiered
        .map((tier) => ({
          kind: tier.kind,
          thresholdTokens: tier.thresholdTokens,
          costPerMToken: tier.costPerMToken,
        }))
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.thresholdTokens - b.thresholdTokens);
    }
  }
  return detail;
}

function hasNonZeroPrice(price) {
  return (
    finiteNumber(price.inputCostPerMToken) > 0 ||
    finiteNumber(price.cachedInputCostPerMToken) > 0 ||
    finiteNumber(price.outputCostPerMToken) > 0
  );
}

function missingPrice() {
  return {
    inputCostPerMToken: 0,
    cachedInputCostPerMToken: 0,
    outputCostPerMToken: 0,
  };
}

function normalizeModelName(model) {
  return String(model ?? '').trim().toLowerCase();
}

function normalizeKey(model) {
  return normalizeModelName(model);
}

function perTokenToPerMillion(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value * MILLION : undefined;
}

function firstFinite(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function roundCost(value) {
  return Number(value.toFixed(12));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
