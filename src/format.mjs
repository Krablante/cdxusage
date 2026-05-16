export const DEFAULT_LOCALE = 'en-CA';
export const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';

export function formatDisplayDate(dateKey, locale = DEFAULT_LOCALE) {
  const [yearStr = '0', monthStr = '1', dayStr = '1'] = dateKey.split('-');
  const date = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1, Number(dayStr)));
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

export function formatDisplayMonth(monthKey, locale = DEFAULT_LOCALE) {
  const [yearStr = '0', monthStr = '1'] = monthKey.split('-');
  const date = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1, 1));
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
}

export function formatDisplayDateTime(timestamp, locale = DEFAULT_LOCALE, timezone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: timezone || DEFAULT_TIMEZONE,
  }).format(new Date(timestamp));
}

export function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(Math.trunc(Number(value) || 0));
}

export function formatCurrency(value) {
  if (value == null || !Number.isFinite(Number(value))) {
    return 'n/a';
  }
  const amount = Number(value) || 0;
  const fractionDigits = Math.abs(amount) > 0 && Math.abs(amount) < 0.01 ? 6 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}

export function splitUsageTokens(usage) {
  const cacheReadTokens = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens ?? 0);
  const inputTokens = Math.max((usage.inputTokens ?? 0) - cacheReadTokens, 0);
  const outputTokens = Math.max(usage.outputTokens ?? 0, 0);
  const reasoningTokens = Math.max(0, Math.min(usage.reasoningOutputTokens ?? 0, outputTokens));
  return { inputTokens, outputTokens, reasoningTokens, cacheReadTokens };
}

export function modelList(models) {
  return Object.entries(models ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, usage]) => (usage.isFallback ? `${model} (fallback)` : model));
}

export function toPublicUsage(usage) {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    totalTokens: usage.totalTokens,
  };
}

export function toPublicModels(models) {
  const out = {};
  for (const [model, usage] of Object.entries(models ?? {})) {
    out[model] = {
      ...toPublicUsage(usage),
      isFallback: Boolean(usage.isFallback),
    };
  }
  return out;
}
