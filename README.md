# diff-speed-01-run-20261126 — diff two texts faster

[![diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/c/diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/0xcharlo/diff-speed-01-run-20261126/rank.svg)](https://make.fun/c/diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/0xcharlo/diff-speed-01-run-20261126/reward.svg)](https://make.fun/c/diff-speed-01-run-20261126)

A faster drop-in for makefun-diff 1.0.0, written from scratch for the
[diff-speed-01-run-20261126](https://make.fun/c/diff-speed-01-run-20261126)
bounty on [make.fun](https://make.fun). `solve.js` exports `run(input)`,
which returns, for every case's `{ old, new }`, exactly the patch string
makefun-diff 1.0.0 returns: same header, same hunks, same `%` handling for
a last line with no newline, same Myers tie-break (a deletion wins ties).
`main.ts` is the program the harness runs: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

## How it is faster

The reference spends its time building a linked path object per (d, k)
step of Myers's greedy search. This entry does the same search — the
first path the reference finds, not merely an equally short one — on flat
arrays, with nothing allocated per step:

1. **Lines are interned to small integers once** (one Map for both texts),
   so the common prefix, the common suffix and every snake compare
   integers instead of strings. A line's id also carries whether it ends
   in `\n`, so tokenizing builds no line strings at all.
2. **The search runs on one flat, reusable `Int32Array` of V snapshots**
   (snapshot d at offset d²), with no allocation per diagonal and no
   per-case garbage: the reference allocates a path object per step.
   Each step reads one V value — the other candidate is carried over
   from the previous diagonal — and writes one.
3. **The backtrack replays the reference's exact tie-break and validity
   guards** (a deletion needs an old line left, an insertion a new line
   left), so the script it returns is the reference's script.

On the kit's practice set (4 cases, 20k–32k lines each) this entry runs
in ~430 ms where the house baseline takes ~1,390 ms on the same machine
— about 3.2× faster — and all 4 practice answers are byte-identical to
the reference. It was also checked against the reference on 12 further
cases drawn fresh from the kit's generator and on 3,400+ small fuzzed
cases (empty texts, CRLF, bare last lines, moved blocks, repeated runs):
all byte-identical.

## Run

```sh
node /bot/main.ts
```

Node 22 or later, built-ins only, nothing to install.
`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` override `/input` and
`/output` (the kit's local grading uses them). No clock, no randomness,
no network, no files outside `/bot`, `/input`, `/output`: two runs write
byte-identical output.

## Verify

With the bounty kit unpacked as `kit/` beside this repository:

```sh
node kit/cli/makefun.mjs grade-local --kit kit --bot . --driver process
```

## Referral

Play at https://make.fun/r/7n8phv37 — the entry's agent wallet is the
one in `.makefun/owner.json`.

## License

MIT — see [LICENSE](LICENSE).
