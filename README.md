# Exact, Faster Site Generator

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/kangrisuk-id/makefun-sitegen-speed-20261123/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/kangrisuk-id/makefun-sitegen-speed-20261123/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A dependency-free drop-in replacement for **makefun-site 1.0.0** that returns its output tree **byte for byte** — every page's `index.html`, the index and tag pages, `build-report.txt` and each static file — at roughly **a quarter of the CPU time**.

![Hero: byte-exact output at a quarter of the CPU, 3.72× on the practice set and 4.18× on a fresh 12-case set](docs/hero.svg)

## At a glance

| | This entry |
|---|---|
| Contract | `solve.js` exports `run(input)`; `main.ts` answers every case in `/input/cases.json` into `/output/answers.json` |
| Output | Identical to makefun-site 1.0.0 on every case tested — 24 / 24 cases, 9,721 source files |
| Speed | **3.72×** faster than the baseline on the practice set; **4.18×** on 12 fresh cases from the contest's own generator (median CPU, paired A/B) |
| Dependencies | None — plain ES module + the Node 22 standard library |
| Cross-case state | None: every `run()` builds its tables from scratch |

## Gallery

| Benchmark | Where the time goes |
|---|---|
| ![CPU benchmark bars: baseline 1,286 ms vs 345 ms on the practice set, 5,858 ms vs 1,402 ms on the fresh corpus](docs/benchmark.svg) | ![Pipeline notes: front-matter scanner, fused Markdown pass, memoised text rules, buffered template rendering](docs/pipeline.svg) |
| *Median CPU over full passes, baseline measured beside the entry on the same machine.* | *The four hot stages of a build, and the single-pass treatment each one gets.* |

| Exactness evidence |
|---|
| ![Exactness checklist: practice set, fresh generator sets, hand-built edge sites, determinism](docs/exactness.svg) |
| *Speed only counts behind the gate: one differing byte and the entry ranks below every exact one.* |

## What v2 changes

This is the second version of this entry, profiled and rebuilt against the first. A CPU profile of v1 put the time in four places — template rendering (20%), inline Markdown (18%), block Markdown (18%) and word counting (10%) — and v2 attacks the first three:

- **Templates are compiled, not interpreted.** Each template is compiled once per case into a plain JS function (literal text, scope-stack path lookups, JS loops, one string accumulator) instead of walking a node tree per render. The v1 tree interpreter remains as an automatic fallback if dynamic compilation is unavailable, and the fallback path is tested separately — it is exact on every suite too.
- **Inline rendering works on ranges.** Strong/emphasis/link segments recurse on index ranges of the original string instead of slicing a copy of every nested segment; plain runs are located by regex and copied as slices.
- **One fused line classification.** Each Markdown line is classified once (blank/fence/heading/rule/quote/bullet/ordered/paragraph) by a single head scan, and block output (fences, lists) is streamed instead of accumulated per line.
- **Cheaper escaping and slugs.** HTML escaping copies plain stretches as slices between special characters (measured 3.6× faster than v1's escaper on corpus text); link-path resolution is memoised per case; the CRLF normalisation only runs when the source actually contains `\r`.

One plausible idea was measured and rejected: regex-based word counting is 1.6–3.6× *slower* than v1's character loop, so the counter stands unchanged. The result, on paired A/B medians (v1 and v2 alternating in each round): the generated corpus drops from 1,717 ms to 1,402 ms of CPU (−18%), a fresh unseen-seed corpus from 1,282 ms to 1,124 ms (−12%), and the practice set from 378 ms to 345 ms (−9%) — with output still byte-identical on all 24 cases, including 9 cases drawn for v2 from seeds no version had seen.

## How it works

makefun-site's dialect is its own — its front matter, template language, Markdown subset, slug rule and build report are re-implemented here from the reference's specification, then made fast where the reference spends its time:

- **Front matter** is scanned line by line over the header only; the body is the untouched remainder of the file, never an array of lines joined back together.
- **Markdown** lexing and rendering are fused into a single pass. Lines are classified by direct character checks instead of a stack of regular expressions, and inline rendering copies plain runs as slices, escaping only the characters that need it.
- **Slugify** takes an ASCII fast path (NFKD normalisation is the identity on ASCII, so the result is unchanged) and is memoised per case, as are long dates; word counts are a single scan with no match array.
- **Templates** are compiled once per case into plain JS functions that append into one output buffer shared across includes and loops (with the parsed node-tree interpreter kept as an exact fallback).
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
