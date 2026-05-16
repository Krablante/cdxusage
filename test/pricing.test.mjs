import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  calculateCostFromUsageOrEvents,
  calculateCostUSD,
  loadPricingCatalog,
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
assert.equal(bundledGpt55Priority.detail.source, 'openai-priority-official-bundled');

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
  assert.equal(officialGpt55.detail.source, 'openai-official');
} finally {
  globalThis.fetch = officialPriorityFetch;
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
