# cdxusage

<p align="center">
  <strong>A fast, local Codex usage meter for tokens, sessions, and estimated OpenAI cost.</strong>
</p>

<p align="center">
  <code>npx -y github:Krablante/cdxusage monthly</code>
</p>

<p align="center">
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-555">
  <img alt="Node 20.19.4+" src="https://img.shields.io/badge/node-%3E%3D20.19.4-339933">
  <img alt="Codex compatible" src="https://img.shields.io/badge/codex-compatible-444">
  <img alt="OpenAI pricing only" src="https://img.shields.io/badge/pricing-OpenAI%20only-111">
  <img alt="No database" src="https://img.shields.io/badge/database-none-0f766e">
</p>

`cdxusage` reads local Codex CLI history and shows daily, monthly, or
per-session usage: input tokens, cached input, output, reasoning tokens, and an
estimated API-equivalent OpenAI cost.

It is built for large Codex histories. The original
`npx -y @ccusage/codex@latest` path can become painful on big archives: long
CPU-bound scans, very high RAM use, and sometimes multi-GB to tens-of-GB memory
growth before it finishes. `cdxusage` avoids that shape by streaming JSONL
files, indexing compact per-file summaries, and reusing a small local cache.

No SQLite. No daemon. No provider catalogs. No background service.

## Quick Start

Run directly from GitHub:

```bash
npx -y github:Krablante/cdxusage monthly
```

Or from a clone:

```bash
git clone https://github.com/Krablante/cdxusage.git
cd cdxusage
node ./bin/cdxusage.mjs monthly
```

Useful reports. These examples assume `cdxusage` is installed or you are inside
a clone; for one-off GitHub runs, replace `cdxusage` with
`npx -y github:Krablante/cdxusage`.

```bash
cdxusage daily
cdxusage monthly
cdxusage session
cdxusage monthly --json --include-stats
cdxusage session --since 2026-05-01 --sort cost --order desc
```

## What You Get

- `daily`, `monthly`, `session`, and `sessions` alias
- pretty terminal tables and JSON output
- date filters, timezone, locale, sorting, compact tables
- automatic Codex home discovery on Linux, macOS, Windows, and WSL
- OpenAI/Codex pricing only, with missing non-OpenAI model prices reported
- offline pricing fallback and disposable local caches
- portable folder build with Linux/macOS shell, Windows CMD, and PowerShell launchers

## Auto Discovery

By default, `cdxusage` does a bounded search only. It checks explicit inputs
first, then likely Codex locations:

- `--codex-home`, `--sessions-dir`, and `CODEX_HOME`
- current and near-parent `.codex`
- `~/.codex`
- `USERPROFILE\.codex`
- `APPDATA\Codex`
- `LOCALAPPDATA\Codex`
- WSL mappings for Windows-style paths

It does not crawl your whole disk. Override discovery when needed:

```bash
cdxusage monthly --codex-home ~/.codex
cdxusage monthly --sessions-dir ~/.codex/sessions
```

## Pricing

Default pricing mode is `auto`.

`cdxusage` reads the resolved Codex home's `config.toml`. If it sees
`service_tier = "priority"` or legacy `service_tier = "fast"`, it applies
OpenAI priority prices to OpenAI models that currently expose official priority
rates.

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

Known official long-context rules are applied when needed. For example,
standard GPT-5.5 and GPT-5.4 sessions above 272K input tokens use OpenAI's
long-context rates, while priority pricing falls back to standard pricing for
long-context requests that OpenAI excludes from Priority Processing.

Non-OpenAI model routes are not guessed. They are reported in
`pricing.missingModels` when stats are enabled.

`costUSD` is an estimate based on logged input, cached input, and output tokens.
It is not an invoice and may differ from subscription or credit accounting
screens.

## Performance

Run the local benchmark helper against your own Codex archive:

```bash
npm run benchmark -- --since 2026-05-01 --upstream-timeout 25 --cdxusage-timeout 90
```

Recent local sanity check on a large Codex history:

| Tool | Scenario | Time | RAM | Result |
| --- | --- | ---: | ---: | --- |
| `@ccusage/codex@18.0.11` | `--since 2026-05-01`, 25s limit | `>25.03s` | `0.10 GB` before timeout | timed out |
| `cdxusage` | same filter, cold full scan | `36.90s` | `0.32 GB` | complete |
| `cdxusage` | same filter, warm cached | `0.46s` | `0.14 GB` | complete |

Cold scans read every matching JSONL file for correctness, including resumed
long-lived sessions whose recent events may live in older session files. After
the cache is built, the same report is dramatically faster: in this run, the
warm cached path was at least 98.2% faster than the upstream timeout window.

The timeout keeps the upstream run from reaching its worst failure mode. On
large histories, that path can continue growing into multi-GB or tens-of-GB RAM
use; `cdxusage` keeps memory bounded and predictable instead of loading a huge
archive shape into RAM.

## Portable Folder

Build a self-contained folder:

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

## Compatibility

`cdxusage` keeps the useful `@ccusage/codex` UX shape: report modes, JSON,
pretty tables, filters, offline mode, and terminal-friendly output. See
[docs/compatibility.md](docs/compatibility.md) for details.

Intentional differences:

- binary is `cdxusage`
- default pricing is `auto`, not always standard
- impossible calendar dates are rejected
- mixed `last_token_usage` and cumulative-only `total_token_usage` is
  de-duplicated instead of reproducing upstream overcounts
- non-OpenAI model prices are reported missing instead of filled from provider
  catalogs

## Development

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
(`CDXUSAGE_MAX_CACHE_BYTES`, default 64 MiB, minimum 1 MiB) are ignored on load
and skipped on save.
