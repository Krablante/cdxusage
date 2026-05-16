# cdxusage

Fast CLI for OpenAI Codex usage: tokens, sessions, and estimated cost.

`cdxusage` scans Codex CLI JSONL sessions without loading the whole archive into
memory. It auto-discovers Codex data on Linux, macOS, Windows, and WSL, reads
`config.toml` for priority/fast mode, and keeps only compact disposable file
caches. No SQLite, Postgres, daemon, or permanent database.

## Quick Start

Run from GitHub with npx:

```bash
npx -y github:Krablante/cdxusage monthly
```

Run from a clone:

```bash
git clone https://github.com/Krablante/cdxusage.git
cd cdxusage
node ./bin/cdxusage.mjs monthly
```

Useful commands:

```bash
node ./bin/cdxusage.mjs daily
node ./bin/cdxusage.mjs monthly
node ./bin/cdxusage.mjs session
node ./bin/cdxusage.mjs monthly --json --include-stats
node ./bin/cdxusage.mjs monthly --no-priority
node ./bin/cdxusage.mjs session --since 2026-05-01 --sort cost --order desc
```

## Portable Folder

Build a self-contained folder with Linux/macOS, Windows CMD, and PowerShell
launchers:

```bash
npm run portable:build
cd portable
sh ./cdxusage monthly
```

Windows:

```bat
cd portable
.\cdxusage.cmd monthly
```

PowerShell:

```powershell
cd portable
.\cdxusage.ps1 monthly
```

Portable mode still needs Node.js `>=20.19.4`, but it does not need
`npm install`.

## Auto Discovery

Unless you pass `--codex-home`, `--sessions-dir`, or `CODEX_HOME`, discovery is
bounded and checks only likely Codex locations:

- current and near-parent `.codex`
- `~/.codex`
- `HOME/.codex`
- `USERPROFILE\.codex`
- `APPDATA\Codex`
- `LOCALAPPDATA\Codex`
- WSL mappings for Windows-style paths when running under Linux/WSL

There is no full-disk search. If discovery picks the wrong folder, override it:

```bash
cdxusage monthly --codex-home ~/.codex
cdxusage monthly --sessions-dir ~/.codex/sessions
```

## Pricing

Default pricing mode is `auto`.

`cdxusage` reads the resolved Codex home's `config.toml`. If it sees
`service_tier = "priority"` or legacy `service_tier = "fast"`, it applies
OpenAI priority prices to all OpenAI models that currently expose official
priority rates.

Force standard pricing:

```bash
cdxusage monthly --no-priority
cdxusage monthly --speed standard
```

Force priority pricing:

```bash
cdxusage monthly --speed fast
cdxusage monthly --speed fast --priority-models all
cdxusage monthly --speed fast --priority-models gpt-5.5,gpt-5.4-mini
```

Pricing sources are intentionally OpenAI-only:

1. live OpenAI API pricing docs
2. live OpenAI Priority Processing pricing
3. bundled OpenAI/Codex fallback snapshot

Non-OpenAI model routes are reported in `pricing.missingModels`. `cdxusage`
does not fetch or price non-OpenAI provider catalogs.

`costUSD` is an estimated API-equivalent value based on logged input, cached
input, and output tokens. It is not an invoice and may differ from subscription
credit/accounting screens.

## Compatibility

See [docs/compatibility.md](docs/compatibility.md).

Implemented report modes:

- `daily`
- `monthly`
- `session`
- `sessions` alias

Supported output/features:

- pretty terminal tables
- JSON output
- date filters
- timezone and locale
- offline pricing/cache mode
- compact tables
- sort/order extensions
- token cache and pricing cache controls

Intentional differences from `@ccusage/codex`:

- binary is `cdxusage`
- default pricing is `auto`, not always standard
- impossible calendar dates are rejected
- mixed `last_token_usage` and cumulative-only `total_token_usage` is
  de-duplicated instead of reproducing upstream overcounts
- non-OpenAI model prices are reported missing instead of filled from provider
  catalogs

## Benchmarks

Run the local benchmark helper against your own Codex archive:

```bash
npm run benchmark -- --since 2026-05-01 --timeout 25
```

It runs `cdxusage` cold, `cdxusage` warm, and
`npx -y @ccusage/codex@latest` with the same date filter. On Linux it also
captures max RSS through `/usr/bin/time -v`.

Recent local sanity check on a large Codex archive:

| Tool | Scenario | Time | RSS | Result |
| --- | --- | ---: | ---: | --- |
| `@ccusage/codex@18.0.11` | `--since 2026-05-01`, timeout 25s | `>25.01s` | n/a | timed out |
| `cdxusage` | same filter, cold full scan | `36.57s` | `359440KB` | complete |
| `cdxusage` | same filter, warm cached | `0.43s` | `150960KB` | complete |

The cold path scans every matching JSONL file for correctness, including
long-lived resumed sessions whose events may fall far outside the session path
date. The warm cached path was at least 98.3% faster than upstream's bounded
timeout in this run. Upstream did not complete in the timeout window, so
upstream final RSS is not comparable for this real-profile check.

Live pricing status from a fresh check: OpenAI official + bundled fallback,
`modelCount: 65`. Non-OpenAI routes, if present in local Codex logs, are left
unpriced and reported in `pricing.missingModels`.

## Verification

```bash
npm run check
npm run lint
npm run typecheck
npm test
npm run smoke
npm run portable:smoke
npm pack --dry-run --json
```

Caches live under `${XDG_CACHE_HOME:-$HOME/.cache}/cdxusage/` by default and
are safe to delete. Token cache files above `--max-cache-bytes`
(`CDXUSAGE_MAX_CACHE_BYTES`, default 64MiB, minimum 1MiB) are ignored on load
and skipped on save.
