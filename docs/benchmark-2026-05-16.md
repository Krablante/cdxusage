# Benchmark Evidence: 2026-05-16

This is a local sanity check on a large Codex history. It is not a universal
benchmark claim; run `npm run benchmark` on your own archive for local numbers.

The public benchmark helper resolves `@ccusage/codex@latest`, finds the actual
`ccusage-codex` binary, and measures that process directly. This avoids
underreporting RAM by timing only the `npx` wrapper.

Command:

```bash
npm run benchmark -- --since 2026-05-01 --upstream-timeout 45 --cdxusage-timeout 90
```

Raw output:

```text
| Tool | Time | RAM | Result |
| --- | ---: | ---: | --- |
| cdxusage cold | 31.61s | 0.37 GB | complete |
| cdxusage warm | 0.41s | 0.16 GB | complete |
| @ccusage/codex@18.0.11 | >45.03s | 2.38 GB | timed out (124) |
```

Interpretation:

- Cold `cdxusage` scans read the archive for correctness, including resumed
  sessions whose recent activity can live in older session files.
- Warm `cdxusage` uses the compact file cache/index and completed at least
  99.1% faster than the upstream timeout window in this run.
- The upstream run was stopped at 45 seconds before completion; RAM shown is
  the measured maximum before timeout, not a completed-run peak.
