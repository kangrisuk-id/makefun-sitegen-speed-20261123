# Exact, Faster Site Generator

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/kangrisuk-id/makefun-sitegen-speed-20261123/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/kangrisuk-id/makefun-sitegen-speed-20261123/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A dependency-free drop-in replacement for **makefun-site 1.0.0** that returns its output tree **byte for byte** — every page's `index.html`, the index and tag pages, `build-report.txt` and each static file — at roughly **a third of the CPU time**.

![Hero: byte-exact output at a third of the CPU, 2.79× on the practice set and 3.43× on a fresh 12-case set](docs/hero.svg)

## At a glance

| | This entry |
|---|---|
| Contract | `solve.js` exports `run(input)`; `main.ts` answers every case in `/input/cases.json` into `/output/answers.json` |
| Output | Identical to makefun-site 1.0.0 on every case tested — 15 / 15 cases, 6,122 source files |
| Speed | **2.79×** faster than the baseline on the practice set; **3.43×** on 12 fresh cases from the contest's own generator (median CPU) |
| Dependencies | None — plain ES module + the Node 22 standard library |
| Cross-case state | None: every `run()` builds its tables from scratch |

## Gallery

| Benchmark | Where the time goes |
|---|---|
| ![CPU benchmark bars: baseline 838 ms vs 300 ms on the practice set, 5,929 ms vs 1,729 ms on the fresh corpus](docs/benchmark.svg) | ![Pipeline notes: front-matter scanner, fused Markdown pass, memoised text rules, buffered template rendering](docs/pipeline.svg) |
| *Median CPU over full passes, baseline measured beside the entry on the same machine.* | *The four hot stages of a build, and the single-pass treatment each one gets.* |

| Exactness evidence |
|---|
| ![Exactness checklist: practice set, fresh generator sets, hand-built edge sites, determinism](docs/exactness.svg) |
| *Speed only counts behind the gate: one differing byte and the entry ranks below every exact one.* |

## How it works

makefun-site's dialect is its own — its front matter, template language, Markdown subset, slug rule and build report are re-implemented here from the reference's specification, then made fast where the reference spends its time:

- **Front matter** is scanned line by line over the header only; the body is the untouched remainder of the file, never an array of lines joined back together.
- **Markdown** lexing and rendering are fused into a single pass. Lines are classified by direct character checks instead of a stack of regular expressions, and inline rendering copies plain runs as slices, escaping only the characters that need it.
- **Slugify** takes an ASCII fast path (NFKD normalisation is the identity on ASCII, so the result is unchanged) and is memoised per case, as are long dates; word counts are a single scan with no match array.
- **Templates** are parsed once per case into node trees and rendered by appending into one output buffer shared across includes and loops.
- Link resolution, collections, tag grouping, permalinks and the sorted build report follow the reference's order and messages exactly — including its refusal reasons, broken-link records and shadowed-static notes.

## Run it

```sh
# the harness driver (Node 22.18+)
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

`main.ts` reads `{id, input}` cases from `cases.json`, answers each with `run()` from `solve.js`, and writes the answers array to `answers.json`.

## Verification

Before submission the entry was checked against makefun-site 1.0.0 itself, not just the practice answers: the kit practice set, twelve fresh cases drawn by the competition's own generator from unseen seeds (200–600 Markdown sources and 14–30 templates per case), and a hand-built edge suite covering Unicode slugs and the 64-character cut, every front-matter refusal, fenced/unclosed code, list continuations, include cycles and template parse errors. Every comparison was byte-for-byte, and repeated runs are deterministic.

---

<sub>Entered on [make.fun](https://make.fun/?ref=6xwwxtxr&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
