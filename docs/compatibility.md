# Compatibility Map

Baseline: `@ccusage/codex@18.0.11`, npm package binary
`ccusage-codex`, inspected from the npm package metadata/help output and the
public ccusage Codex guide.

## Commands

| Upstream | cdxusage | Status |
| --- | --- | --- |
| default `daily` | default `daily` | supported |
| `daily` | `daily` | supported |
| `monthly` | `monthly` | supported |
| `session` | `session` | supported |
| README-era `sessions` | `sessions` alias | extension |

## Shared Options

| Option | Status |
| --- | --- |
| `-j, --json` | supported |
| `-s, --since <since>` | supported |
| `-u, --until <until>` | supported |
| `-z, --timezone <timezone>` | supported |
| `-l, --locale <locale>` | supported |
| `-O, --offline` | supported |
| `--no-offline` | supported |
| `--compact` | supported |
| `--color` | supported |
| `--noColor` | supported |
| `--no-color` | supported alias |
| `-h, --help` | supported |
| `-v, --version` | supported |

`cdxusage` also adds explicit operational flags:

- `--codex-home`
- `--sessions-dir`
- `--cache-file`
- `--pricing-cache-file`
- `--pricing-ttl-hours`
- `--pricing-fetch-timeout-ms`
- `--discovery`, `--discovery-mode`
- `--max-cache-bytes`
- `--clear-cache`
- `--no-cache`
- `--no-save-cache`
- `--no-pricing`
- `--include-stats`
- `--speed <auto|standard|fast>`
- `--no-priority`
- `--priority-models <list|all>`
- `--sort <auto|date|month|lastActivity|tokens|cost|input|output|session|directory>`
- `--order <asc|desc>`

## Scanner Diagnostics

Default scanner selection is `auto`: on Linux hosts with working `perl` and
GNU-compatible `xargs -r`, `cdxusage` uses a native batch prefilter for cold
full scans and falls back to the Node scanner when native tooling is
unavailable or fails. Other platforms use the Node scanner unless explicitly
forced for diagnostics. Tail reads and cached files keep the normal cache
semantics.

Internal diagnostic override:

```bash
CDXUSAGE_SCAN_MODE=node cdxusage daily
CDXUSAGE_SCAN_MODE=grep-batch cdxusage daily
```

This is not an upstream compatibility surface. With `--include-stats`,
`scannerModes` reports aggregate scanner counts, `linesSeen` is physical JSONL
lines scanned, `candidateLinesSeen` is the subset containing `turn_context` or
`token_count`, and `nativeOutputBytes` is candidate byte volume delivered into
Node processing. Cache files and stats output can include absolute local paths,
model names, token volumes, and estimated cost metadata.

## JSON Output

`daily --json`:

```json
{
  "daily": [
    {
      "date": "May 16, 2026",
      "dateKey": "2026-05-16",
      "inputTokens": 1000,
      "cachedInputTokens": 200,
      "outputTokens": 100,
      "reasoningOutputTokens": 40,
      "totalTokens": 1100,
      "costUSD": 0.002025,
      "models": {
        "gpt-5": {
          "inputTokens": 1000,
          "cachedInputTokens": 200,
          "outputTokens": 100,
          "reasoningOutputTokens": 40,
          "totalTokens": 1100,
          "isFallback": false
        }
      }
    }
  ],
  "totals": {
    "inputTokens": 1000,
    "cachedInputTokens": 200,
    "outputTokens": 100,
    "reasoningOutputTokens": 40,
    "totalTokens": 1100,
    "costUSD": 0.002025
  }
}
```

`monthly --json` uses the upstream keys `monthly` and `month`, and adds stable
`monthKey` for machine consumers.

`session --json` uses the upstream keys `sessions`, `sessionId`,
`lastActivity`, `sessionFile`, and `directory`.

If a filter produces no rows, `totals` is `null`, matching upstream.

If `--no-pricing` is used, `costUSD` is `null` in JSON and `n/a` in tables.

## Table Output

Column-compatible tables are implemented:

- daily/monthly: date or month, models, input, output, reasoning, cache read,
  total tokens, cost
- session: date, directory, session, models, input, output, reasoning, cache
  read, total tokens, cost, last activity

The renderer is local code rather than upstream `cli-table3`, so exact ANSI and
wrapping may differ. The table is intended to be compatible for human terminal
use, not byte-identical snapshot output.

## Pricing

`cdxusage` intentionally prices only OpenAI/Codex models:

1. OpenAI API pricing docs
2. OpenAI Priority Processing pricing
3. bundled OpenAI/Codex fallback snapshot

Cost is estimated as:

```text
non_cached_input * input_price
+ cached_input * cache_read_price
+ output * output_price
```

For long-context tiered prices, `cdxusage` keeps compact per-threshold billing
summaries in the file cache. Thresholds are applied to request/input context
length without storing every token event in memory or cache.
Known official long-context uplifts, including standard GPT-5.5 and GPT-5.4
sessions above 272K input tokens, are also applied when reading older pricing
caches that predate those tier records.
Priority Processing prices are not applied to long-context requests that OpenAI
excludes from Priority Processing; those event buckets fall back to standard
pricing, including standard long-context tiers when applicable.

Default pricing is `auto`. It reads the resolved Codex home `config.toml` and
treats `service_tier = "priority"` or legacy `"fast"` as priority pricing.
Codex logs do not expose per-request service tier, so auto mode prices all
OpenAI models with official priority rates as priority when the resolved config
sets priority/fast mode. Use `--no-priority` or `--speed standard` to force
non-priority pricing. Use `--priority-models all` or a comma-separated list to
override the priority scope.

Non-OpenAI model routes are not estimated. They appear in
`pricing.missingModels` when `--include-stats` is used.

## Correctness Differences

One intentional difference: when a session mixes an event with only
`last_token_usage` and a later event with only cumulative `total_token_usage`,
`cdxusage` advances the cumulative scan state after the last-only event to
avoid double-counting it. `@ccusage/codex@18.0.11` can overcount that
malformed/mixed sequence.

Another intentional difference: impossible calendar dates such as `2026-02-30`
are rejected.
