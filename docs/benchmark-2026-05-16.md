# Benchmark Evidence: 2026-05-16

This is dated local evidence from a large Codex history plus static synthetic
fixtures. It is not a universal benchmark claim; run `npm run benchmark` on
your own archive for local numbers.

## Real Profile

Command shape:

```bash
node ./bin/cdxusage.mjs daily \
  --offline --since 2026-05-01 \
  --include-stats --json
```

The comparison uses the previous public commit `1c084b4` as the baseline and
the current native-auto scanner worktree as the selected run. Runs are
application-cache-cold/page-cache-warm on an actively changing local archive, so
use the synthetic fixtures below for strict accuracy checks.

| Tool | Scenario | Wall | CPU | RAM | Result |
| --- | --- | ---: | ---: | ---: | --- |
| `cdxusage` pre-native baseline | cold app cache | `27.80s` | `45.36s` | `0.350 GB` | complete |
| `cdxusage` native auto scanner | cold app cache | `10.46s` | `16.82s` | `0.180 GB` | complete |
| `cdxusage` pre-native baseline | warm app cache | `0.40s` | `0.57s` | `0.166 GB` | complete |
| `cdxusage` native auto scanner | warm app cache | `0.30s` | `0.46s` | `0.143 GB` | complete |

Cold native auto versus pre-native baseline:

- 62.4% less wall time
- 62.9% less CPU time
- 48.5% less RAM
- 4,219 JSONL files, about 9.24GB logical source bytes
- about 0.65GB candidate bytes delivered into Node candidate-line processing
- about 93.0% less candidate data delivered from full-scan source bytes into
  Node candidate-line processing

The live archive changed between sequential real runs, so token totals are not
used as strict accuracy evidence here.

## Synthetic Fixtures

Static fixture run comparing public commit `1c084b4` with the native-auto
worktree:

| Scenario | Cold wall saved | Cold CPU saved | RAM saved | Accuracy |
| --- | ---: | ---: | ---: | --- |
| small | 18.2% | 8.3% | 1.1% | match |
| medium | 42.5% | 28.3% | -1.2% | match |
| large | 59.1% | 44.1% | 14.2% | match |
| huge | 60.9% | 47.7% | 29.7% | match |
| adversarial | 27.8% | 14.3% | 3.5% | match |

## Notes

- Cold `cdxusage` scans read the archive for correctness, including resumed
  sessions whose recent activity can live in older session files.
- Warm `cdxusage` uses the compact file cache/index and should normally be
  dominated by changed or appended files.
- Native acceleration depends on Linux/GNU-compatible tools. Other platforms or
  native failures use the Node scanner.
- `nativeOutputBytes` is candidate byte volume delivered into Node processing;
  `bytesRead` remains the logical source byte count.
- The public benchmark helper still resolves and times `@ccusage/codex@latest`
  directly when you want an upstream comparison on your own machine.
