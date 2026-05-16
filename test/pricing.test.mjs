import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  calculateCostFromUsageOrEvents,
  calculateCostUSD,
  loadPricingCatalog,
  parseOpenAIDevPricingHtml,
} from '../src/pricing.mjs';

const root = path.join(tmpdir(), `cdxusage-pricing-${process.pid}`);
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const catalog = await loadPricingCatalog({
  pricingData: {
    'gpt-test': {
      inputCostPerMToken: 1,
      cachedInputCostPerMToken: 0.1,
      outputCostPerMToken: 2,
    },
  },
});
const resolved = catalog.getPricing('gpt-test');
assert.equal(resolved.missing, false);
assertClose(calculateCostUSD({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 }, resolved.price), 0.0000104);

const bundledStandard = await loadPricingCatalog({
  offline: true,
  cacheFile: path.join(root, 'missing-standard-cache.json'),
});
const bundledGpt55Standard = bundledStandard.getPricing('gpt-5.5');
assert.deepEqual(bundledGpt55Standard.price.tiered, [
  { kind: 'input_cost_per_token', thresholdTokens: 272_000, costPerMToken: 10 },
  { kind: 'cache_read_input_token_cost', thresholdTokens: 272_000, costPerMToken: 1 },
  { kind: 'output_cost_per_token', thresholdTokens: 272_000, costPerMToken: 45 },
]);
const bundledGpt55ProStandard = bundledStandard.getPricing('gpt-5.5-pro');
assert.equal(bundledGpt55ProStandard.price.cachedInputCostPerMToken, 30);
assert.deepEqual(bundledGpt55ProStandard.price.tiered, [
  { kind: 'input_cost_per_token', thresholdTokens: 272_000, costPerMToken: 60 },
  { kind: 'cache_read_input_token_cost', thresholdTokens: 272_000, costPerMToken: 60 },
  { kind: 'output_cost_per_token', thresholdTokens: 272_000, costPerMToken: 270 },
]);
assert.deepEqual(bundledStandard.metadata.billingThresholds, [272_000]);
assertClose(
  calculateCostFromUsageOrEvents(
    { inputTokens: 300_000, cachedInputTokens: 100_000, outputTokens: 10_000 },
    bundledGpt55Standard.price,
    { version: 1, count: 1, totals: [200_000, 100_000, 10_000], over: { 272_000: [200_000, 100_000, 10_000] } },
  ),
  2.55,
);
const bundledGpt54Standard = bundledStandard.getPricing('gpt-5.4');
assert.deepEqual(bundledGpt54Standard.price.tiered, [
  { kind: 'input_cost_per_token', thresholdTokens: 272_000, costPerMToken: 5 },
  { kind: 'cache_read_input_token_cost', thresholdTokens: 272_000, costPerMToken: 0.5 },
  { kind: 'output_cost_per_token', thresholdTokens: 272_000, costPerMToken: 22.5 },
]);
const bundledGpt54ProStandard = bundledStandard.getPricing('gpt-5.4-pro');
assert.equal(bundledGpt54ProStandard.price.cachedInputCostPerMToken, 30);
assert.deepEqual(bundledGpt54ProStandard.price.tiered, [
  { kind: 'input_cost_per_token', thresholdTokens: 272_000, costPerMToken: 60 },
  { kind: 'cache_read_input_token_cost', thresholdTokens: 272_000, costPerMToken: 60 },
  { kind: 'output_cost_per_token', thresholdTokens: 272_000, costPerMToken: 270 },
]);

const parsedStandard = parseOpenAIDevPricingHtml(
  '<div component-export="TextTokenPricingTables" props="&quot;tier&quot;:[0,&quot;standard&quot;],[0,&quot;GPT-5.5&quot;],[0,5],[0,0.5],[0,30]"></div>',
  { tier: 'standard' },
);
assert.deepEqual(parsedStandard['gpt-5.5'].tiered, bundledGpt55Standard.price.tiered);

const groupedPricingHtml = [
  '<div data-content-switcher-pane="true" data-value="standard">',
  '<astro-island component-export="GroupedPricingTable" props="&quot;headings&quot;:[1,[[0,&quot;Category&quot;],[0,&quot;Model&quot;],[0,&quot;Input&quot;],[0,&quot;Cached input&quot;],[0,&quot;Output&quot;]]],&quot;groups&quot;:[1,[[0,{&quot;model&quot;:[0,&quot;Codex&quot;],&quot;rows&quot;:[1,[[1,[[0,&quot;gpt-5.3-codex&quot;],[0,1.75],[0,0.175],[0,14]]]]]}]]]}"></astro-island>',
  '</div>',
  '<div data-content-switcher-pane="true" data-value="priority">',
  '<astro-island component-export="GroupedPricingTable" props="&quot;headings&quot;:[1,[[0,&quot;Category&quot;],[0,&quot;Model&quot;],[0,&quot;Input&quot;],[0,&quot;Cached input&quot;],[0,&quot;Output&quot;]]],&quot;groups&quot;:[1,[[0,{&quot;model&quot;:[0,&quot;Codex&quot;],&quot;rows&quot;:[1,[[1,[[0,&quot;gpt-5.3-codex&quot;],[0,3.5],[0,0.35],[0,28]]]]]}]]]}"></astro-island>',
  '</div>',
].join('');
const parsedGroupedStandard = parseOpenAIDevPricingHtml(groupedPricingHtml, { tier: 'standard' });
assert.equal(parsedGroupedStandard['gpt-5.3-codex'].inputCostPerMToken, 1.75);
const parsedGroupedPriority = parseOpenAIDevPricingHtml(groupedPricingHtml, { tier: 'priority' });
assert.equal(parsedGroupedPriority['gpt-5.3-codex'].inputCostPerMToken, 3.5);
assert.equal(parsedGroupedPriority['gpt-5.3-codex'].cachedInputCostPerMToken, 0.35);
assert.equal(parsedGroupedPriority['gpt-5.3-codex'].outputCostPerMToken, 28);

const oldOpenAiCacheFile = path.join(root, 'old-openai-cache.json');
await writeFile(
  oldOpenAiCacheFile,
  `${JSON.stringify({
    version: 1,
    source: 'openai-official',
    sourceUrl: 'https://developers.openai.com/api/docs/pricing',
    fetchedAt: new Date().toISOString(),
    tier: 'standard',
    data: {
      'gpt-5.5': {
        inputCostPerMToken: 5,
        cachedInputCostPerMToken: 0.5,
        outputCostPerMToken: 30,
        source: 'openai-official',
        sourceUrl: 'https://developers.openai.com/api/docs/pricing',
        serviceTier: 'standard',
        tierAdjusted: false,
      },
    },
  })}\n`,
);
const oldOpenAiCacheCatalog = await loadPricingCatalog({ offline: true, cacheFile: oldOpenAiCacheFile });
assert.deepEqual(oldOpenAiCacheCatalog.getPricing('gpt-5.5').price.tiered, bundledGpt55Standard.price.tiered);

const priorityCatalog = await loadPricingCatalog({
  tier: 'priority',
  pricingData: {
    'gpt-speed': {
      input_cost_per_token: 0.000001,
      cache_read_input_token_cost: 0.0000001,
      output_cost_per_token: 0.000002,
      input_cost_per_token_priority: 0.0000025,
      cache_read_input_token_cost_priority: 0.0000002,
      output_cost_per_token_priority: 0.000005,
    },
    'gpt-fallback-speed': {
      inputCostPerMToken: 1,
      cachedInputCostPerMToken: 0.1,
      outputCostPerMToken: 2,
    },
  },
});
const speed = priorityCatalog.getPricing('gpt-speed');
assert.equal(speed.price.inputCostPerMToken, 2.5);
assert.equal(speed.price.cachedInputCostPerMToken, 0.19999999999999998);
assert.equal(speed.price.outputCostPerMToken, 5);
const fallbackSpeed = priorityCatalog.getPricing('gpt-fallback-speed');
assert.equal(fallbackSpeed.price.inputCostPerMToken, 1);
assert.equal(fallbackSpeed.price.cachedInputCostPerMToken, 0.1);
assert.equal(fallbackSpeed.price.outputCostPerMToken, 2);

const scopedInjectedPriority = await loadPricingCatalog({
  tier: 'priority',
  priorityModels: ['gpt-speed'],
  pricingData: {
    'gpt-speed': {
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
      input_cost_per_token_priority: 0.0000025,
      output_cost_per_token_priority: 0.000005,
    },
    'gpt-other-speed': {
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000004,
      input_cost_per_token_priority: 0.000007,
      output_cost_per_token_priority: 0.000008,
    },
  },
});
assert.equal(scopedInjectedPriority.getPricing('gpt-speed').price.inputCostPerMToken, 2.5);
assert.equal(scopedInjectedPriority.getPricing('gpt-other-speed').price.inputCostPerMToken, 3);

const bundledPriority = await loadPricingCatalog({
  tier: 'priority',
  offline: true,
  cacheFile: path.join(root, 'missing-priority-cache.json'),
});
const bundledGpt55Priority = bundledPriority.getPricing('gpt-5.5');
assert.equal(bundledGpt55Priority.price.inputCostPerMToken, 12.5);
assert.equal(bundledGpt55Priority.price.cachedInputCostPerMToken, 1.25);
assert.equal(bundledGpt55Priority.price.outputCostPerMToken, 75);
assert.equal(bundledGpt55Priority.price.tiered, undefined);
assert.equal(bundledGpt55Priority.price.priorityExcludedAboveInputTokens, 128_000);
assert.deepEqual(bundledGpt55Priority.price.priorityFallbackPrice.tiered, bundledGpt55Standard.price.tiered);
assert.deepEqual(bundledPriority.metadata.billingThresholds, [128_000, 272_000]);
assert.equal(bundledGpt55Priority.detail.source, 'openai-priority-official-bundled');
assert.equal(bundledGpt55Priority.detail.priorityExcludedAboveInputTokens, 128_000);
assertClose(
  calculateCostFromUsageOrEvents(
    { inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 1_000 },
    bundledGpt55Priority.price,
    { version: 1, count: 1, totals: [100_000, 0, 1_000], over: { 128_000: [0, 0, 0], 272_000: [0, 0, 0] } },
  ),
  1.325,
);
assertClose(
  calculateCostFromUsageOrEvents(
    { inputTokens: 150_000, cachedInputTokens: 0, outputTokens: 1_000 },
    bundledGpt55Priority.price,
    { version: 1, count: 1, totals: [150_000, 0, 1_000], over: { 128_000: [150_000, 0, 1_000], 272_000: [0, 0, 0] } },
  ),
  0.78,
);
assertClose(
  calculateCostFromUsageOrEvents(
    { inputTokens: 300_000, cachedInputTokens: 100_000, outputTokens: 10_000 },
    bundledGpt55Priority.price,
    {
      version: 1,
      count: 1,
      totals: [200_000, 100_000, 10_000],
      over: { 128_000: [200_000, 100_000, 10_000], 272_000: [200_000, 100_000, 10_000] },
    },
  ),
  2.55,
);
assertClose(
  calculateCostUSD({ inputTokens: 300_000, cachedInputTokens: 100_000, outputTokens: 10_000 }, bundledGpt55Priority.price),
  2.55,
);
const officialPriorityFallbackModels = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.3-codex',
  'gpt-5.1',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5.1-codex',
  'gpt-5-codex',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o',
  'gpt-4o-2024-11-20',
  'gpt-4o-2024-08-06',
  'gpt-4o-2024-05-13',
  'gpt-4o-mini',
  'o3',
  'o4-mini',
];
for (const model of officialPriorityFallbackModels) {
  const resolvedPriority = bundledPriority.getPricing(model);
  assert.equal(resolvedPriority.missing, false, `${model} priority fallback should be bundled`);
  assert.equal(
    Boolean(resolvedPriority.price.priorityFallbackPrice),
    true,
    `${model} priority long-context exclusion should have standard fallback pricing`,
  );
}
const bundledGpt4oMayPriority = bundledPriority.getPricing('gpt-4o-2024-05-13');
assert.equal(bundledGpt4oMayPriority.price.inputCostPerMToken, 8.75);
assert.equal(bundledGpt4oMayPriority.price.cachedInputCostPerMToken, 8.75);
assert.equal(bundledGpt4oMayPriority.price.outputCostPerMToken, 26.25);
const bundledGpt53CodexPriority = bundledPriority.getPricing('gpt-5.3-codex');
assert.equal(bundledGpt53CodexPriority.price.inputCostPerMToken, 3.5);
assert.equal(bundledGpt53CodexPriority.price.cachedInputCostPerMToken, 0.35);
assert.equal(bundledGpt53CodexPriority.price.outputCostPerMToken, 28);
assertClose(
  calculateCostFromUsageOrEvents(
    { inputTokens: 129_000, cachedInputTokens: 0, outputTokens: 1_000 },
    bundledPriority.getPricing('gpt-4.1').price,
    { version: 1, count: 1, totals: [129_000, 0, 1_000], over: { 128_000: [129_000, 0, 1_000], 272_000: [0, 0, 0] } },
  ),
  0.266,
);
assertClose(
  calculateCostFromUsageOrEvents(
    { inputTokens: 129_000, cachedInputTokens: 0, outputTokens: 1_000 },
    bundledGpt53CodexPriority.price,
    { version: 1, count: 1, totals: [129_000, 0, 1_000], over: { 128_000: [129_000, 0, 1_000], 272_000: [0, 0, 0] } },
  ),
  0.23975,
);

const oldPriorityCacheFile = path.join(root, 'old-priority-cache.json');
await writeFile(
  oldPriorityCacheFile,
  `${JSON.stringify({
    version: 1,
    source: 'openai-priority-official',
    sourceUrl: 'https://developers.openai.com/api/docs/pricing',
    fetchedAt: new Date().toISOString(),
    tier: 'priority',
    data: {
      'gpt-5.5': {
        inputCostPerMToken: 12.5,
        cachedInputCostPerMToken: 1.25,
        outputCostPerMToken: 75,
        source: 'openai-priority-official',
        sourceUrl: 'https://developers.openai.com/api/docs/pricing',
        serviceTier: 'priority',
        tierAdjusted: true,
      },
    },
  })}\n`,
);
const oldPriorityCacheCatalog = await loadPricingCatalog({ tier: 'priority', offline: true, cacheFile: oldPriorityCacheFile });
assert.equal(oldPriorityCacheCatalog.getPricing('gpt-5.5').price.priorityExcludedAboveInputTokens, 128_000);
assert.deepEqual(oldPriorityCacheCatalog.getPricing('gpt-5.5').price.priorityFallbackPrice.tiered, bundledGpt55Standard.price.tiered);

const scopedPriority = await loadPricingCatalog({
  tier: 'priority',
  priorityModels: ['gpt-5.5'],
  offline: true,
  cacheFile: path.join(root, 'missing-scoped-priority-cache.json'),
});
assert.deepEqual(scopedPriority.metadata.priorityModels, ['gpt-5.5']);
assert.equal(scopedPriority.getPricing('gpt-5.5').price.inputCostPerMToken, 12.5);
assert.equal(scopedPriority.getPricing('gpt-5.4-mini').price.inputCostPerMToken, 0.75);

const codexAutoPriority = await loadPricingCatalog({
  tier: 'priority',
  priorityModels: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5'],
  offline: true,
  cacheFile: path.join(root, 'codex-auto-priority-cache.json'),
});
assert.deepEqual(codexAutoPriority.metadata.priorityModels, ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5']);
assert.equal(codexAutoPriority.getPricing('gpt-5').price.inputCostPerMToken, 1.25);
assert.equal(codexAutoPriority.getPricing('gpt-5.4').price.inputCostPerMToken, 5);
assert.equal(codexAutoPriority.getPricing('gpt-5.4-mini').price.inputCostPerMToken, 1.5);
assert.equal(codexAutoPriority.getPricing('gpt-5.5').price.inputCostPerMToken, 12.5);

const officialPriorityFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes('developers.openai.com')) {
    return {
      ok: true,
      text: async () => `
        <div component-export="TextTokenPricingTables" props="&quot;tier&quot;:[0,&quot;priority&quot;],[0,&quot;GPT-5.5&quot;],[0,12.5],[0,1.25],[0,75]"></div>
      `,
    };
  }
  return {
    ok: false,
    status: 503,
    statusText: 'fixture unavailable',
    text: async () => '',
    json: async () => ({}),
  };
};
try {
  const officialPriorityCatalog = await loadPricingCatalog({
    tier: 'priority',
    priorityModels: ['gpt-5.5'],
    cacheFile: path.join(root, 'official-priority-wins-cache.json'),
    ttlMs: 0,
    fetchTimeoutMs: 1000,
  });
  const officialGpt55 = officialPriorityCatalog.getPricing('gpt-5.5');
  assert.equal(officialGpt55.price.inputCostPerMToken, 12.5);
  assert.equal(officialGpt55.price.cachedInputCostPerMToken, 1.25);
  assert.equal(officialGpt55.price.outputCostPerMToken, 75);
  assert.equal(officialGpt55.detail.source, 'openai-priority-official');
} finally {
  globalThis.fetch = officialPriorityFetch;
}

const cacheSaveFailureFetch = globalThis.fetch;
const pricingCachePathBlocker = path.join(root, 'pricing-cache-path-blocker');
await writeFile(pricingCachePathBlocker, 'not a directory');
globalThis.fetch = async () => ({
  ok: true,
  text: async () => `
    <div component-export="TextTokenPricingTables" props="&quot;tier&quot;:[0,&quot;standard&quot;],[0,&quot;gpt-live-cache-fail&quot;],[0,9],[0,0.9],[0,18]"></div>
  `,
});
try {
  const cacheSaveFailureCatalog = await loadPricingCatalog({
    cacheFile: path.join(pricingCachePathBlocker, 'pricing.json'),
    ttlMs: 0,
    fetchTimeoutMs: 1000,
  });
  assert.equal(cacheSaveFailureCatalog.metadata.cacheState, 'created-cache-save-failed');
  assert.match(cacheSaveFailureCatalog.metadata.cacheSaveError, /EEXIST|ENOTDIR|not a directory/i);
  const livePriceAfterCacheSaveFailure = cacheSaveFailureCatalog.getPricing('gpt-live-cache-fail');
  assert.equal(livePriceAfterCacheSaveFailure.missing, false);
  assert.equal(livePriceAfterCacheSaveFailure.detail.source, 'openai-official');
  assert.equal(livePriceAfterCacheSaveFailure.price.inputCostPerMToken, 9);
} finally {
  globalThis.fetch = cacheSaveFailureFetch;
}

const tierFallbackCatalog = await loadPricingCatalog({
  tier: 'priority',
  pricingData: {
    'gpt-tier-fallback': {
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0,
      cache_read_input_token_cost: 0,
      input_cost_per_token_above_10k_tokens: 0.000003,
    },
  },
});
const tierFallbackPrice = tierFallbackCatalog.getPricing('gpt-tier-fallback').price;
assert.equal(tierFallbackPrice.inputCostPerMToken, 1);
assert.equal(tierFallbackPrice.tiered[0].costPerMToken, 3);
assertClose(
  calculateCostFromUsageOrEvents(
    { inputTokens: 20_000, cachedInputTokens: 0, outputTokens: 0 },
    tierFallbackPrice,
    { version: 1, count: 1, totals: [20_000, 0, 0], over: { 10_000: [20_000, 0, 0] } },
  ),
  0.06,
);

const tierCacheFile = path.join(root, 'pricing-cache.json');
await writeFile(
  tierCacheFile,
  `${JSON.stringify({
    version: 1,
    source: 'fixture-standard-cache',
    sourceUrl: 'fixture',
    fetchedAt: new Date().toISOString(),
    tier: 'standard',
    data: {
      'gpt-cache-tier': {
        inputCostPerMToken: 1,
        cachedInputCostPerMToken: 0.1,
        outputCostPerMToken: 2,
        source: 'fixture',
        sourceUrl: 'fixture',
        serviceTier: 'standard',
        tierAdjusted: false,
      },
    },
  })}\n`,
);
const priorityFromStandardCache = await loadPricingCatalog({ tier: 'priority', cacheFile: tierCacheFile, offline: true });
assert.equal(priorityFromStandardCache.metadata.cacheState, 'offline-cache-tier-mismatch-bundled');
assert.equal(priorityFromStandardCache.getPricing('gpt-cache-tier').missing, true);
const standardFromStandardCache = await loadPricingCatalog({ tier: 'standard', cacheFile: tierCacheFile, offline: true });
assert.equal(standardFromStandardCache.metadata.cacheState, 'offline-cache');
assert.equal(standardFromStandardCache.getPricing('gpt-cache-tier').price.inputCostPerMToken, 1);

const tiered = {
  inputCostPerMToken: 1,
  cachedInputCostPerMToken: 0.1,
  outputCostPerMToken: 2,
  tiered: [
    { kind: 'input_cost_per_token', thresholdTokens: 10, costPerMToken: 3 },
    { kind: 'output_cost_per_token', thresholdTokens: 10, costPerMToken: 20 },
  ],
};
assertClose(
  calculateCostFromUsageOrEvents(
    { inputTokens: 20, cachedInputTokens: 0, outputTokens: 0 },
    tiered,
    { version: 1, count: 1, totals: [20, 0, 0], over: { 10: [20, 0, 0] } },
  ),
  0.00006,
);
assertClose(
  calculateCostFromUsageOrEvents(
    { inputTokens: 20, cachedInputTokens: 0, outputTokens: 1 },
    tiered,
    { version: 1, count: 1, totals: [20, 0, 1], over: { 10: [20, 0, 1] } },
  ),
  0.00008,
);
assertClose(calculateCostFromUsageOrEvents({ inputTokens: 20, cachedInputTokens: 0, outputTokens: 1 }, tiered, [[20, 0, 1]]), 0.00008);

const injectedTieredCatalog = await loadPricingCatalog({
  pricingData: {
    'gpt-tiered-fixture': {
      tiered_pricing: [
        {
          input_cost_per_token: 0.00000005,
          output_cost_per_token: 0.0000004,
          range: [0, 256000],
        },
        {
          input_cost_per_token: 0.00000025,
          output_cost_per_token: 0.000002,
          range: [256000, 1000000],
        },
      ],
    },
  },
});
const injectedTiered = injectedTieredCatalog.getPricing('gpt-tiered-fixture');
assert.equal(injectedTiered.missing, false);
assertClose(injectedTiered.price.inputCostPerMToken, 0.05);
assertClose(injectedTiered.price.outputCostPerMToken, 0.4);
assert.deepEqual(injectedTiered.price.tiered, [
  { kind: 'input_cost_per_token', thresholdTokens: 256_000, costPerMToken: 0.25 },
  { kind: 'output_cost_per_token', thresholdTokens: 256_000, costPerMToken: 2 },
]);
assert.deepEqual(injectedTieredCatalog.metadata.billingThresholds, [256_000]);
assertClose(
  calculateCostFromUsageOrEvents(
    { inputTokens: 300_000, cachedInputTokens: 0, outputTokens: 1_000 },
    injectedTiered.price,
    { version: 1, count: 1, totals: [300_000, 0, 1_000], over: { 256_000: [300_000, 0, 1_000] } },
  ),
  0.077,
);

const nonOpenAiAliasCatalog = await loadPricingCatalog({
  pricingData: {
    'moonshot/kimi-k2.6': {
      inputCostPerMToken: 1,
      cachedInputCostPerMToken: 0.1,
      outputCostPerMToken: 2,
    },
  },
});
assert.equal(nonOpenAiAliasCatalog.getPricing('moonshotai/kimi-k2.6').missing, true);

await rm(root, { recursive: true, force: true });
console.log('pricing ok');

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}
