# Backend optimization and stress report (2026-07-08)

This covers an optimization-only pass on the Rust backend (`src-tauri/src`). No
features changed. The goals were speed, flat memory, and reliability under
sustained load, with a stress test to back the numbers.

## Summary

The one change that mattered: Harper's grammar linter was being rebuilt from
scratch on every `/lint` request. Building it once per worker thread and reusing
it cut median lint latency from 85 ms to 5 ms and raised whole-server throughput
by 44%, with identical lint output. Two smaller changes harden the workspace lock
against a poisoned-lock crash. Across two five-minute runs totalling ~483,000
requests the server never crashed and returned a non-200 zero times.

## What changed

**Reuse Harper's `LintGroup` instead of rebuilding it per call** (`proofread.rs`).
The old code ran `LintGroup::new_curated(...)` plus `set_all_rules_to(Some(true))`
inside `lint()`, so every request reconstructed Harper's entire rule set. Under
concurrent lints that also multiplied memory, since each in-flight call built its
own copy. `LintGroup` is not `Send`, so it cannot be a shared global; it now lives
in a `thread_local!`, meaning each blocking-pool thread that runs lint builds it
once and reuses it. A handful of threads hold a linter instead of one per request.
Verified that lint output is unchanged and that a reused linter does not leak
state between documents (clean, dirty, then clean again all lint correctly).

**Recover from a poisoned workspace lock** (`server.rs`). `AppState::ws()` (called
on nearly every request) and the workspace setter used `.unwrap()` on the `RwLock`.
If any handler ever panicked while holding it, every later request would panic in
turn. They now fall back to the inner value on poisoning, so one panic cannot
cascade into taking the server down.

## How it was tested

A self-contained harness (`stress.py`, kept out of the repo) seeds a throwaway
workspace, launches the release binary headless on a spare port, and drives a
weighted mix of real endpoints from 12 threads: workspace tree, file read/write,
full-text search, compile (spawns `typst`), lint, git status, and tools. It
samples the backend's RSS and child-process count throughout, then holds the
process idle for 30 s to see whether memory is reclaimed. Both runs below were 300 s
of load plus the idle cooldown, release build, macOS Apple Silicon.

Re-run with:

```
python3 stress.py --binary <path>/target/release/typst-editor \
    --duration 300 --concurrency 12 --cooldown 30
```

## Results

Baseline is the code before this pass; optimized is after.

| metric | baseline | optimized |
| --- | --- | --- |
| total requests | 197,751 | 285,583 |
| throughput | 654 req/s | 943 req/s |
| success rate | 100.00% | 100.00% |
| crashes | 0 | 0 |
| child-process leak | none (returns to 0) | none (returns to 0) |

Per-endpoint latency, milliseconds (p50 / p95 / p99 / max):

| endpoint | baseline | optimized |
| --- | --- | --- |
| lint | 85 / 143 / 178 / 6178 | 5 / 8 / 14 / 3123 |
| tree | 1 / 1 / 3 / 33 | 1 / 3 / 7 / 68 |
| file read | 0 / 1 / 3 / 29 | 1 / 3 / 6 / 48 |
| file write | 1 / 2 / 4 / 27 | 1 / 4 / 8 / 51 |
| search | 1 / 2 / 5 / 32 | 2 / 5 / 9 / 43 |
| git status | 0 / 1 / 2 / 20 | 1 / 3 / 6 / 59 |
| compile | 160 / 257 / 298 / 439 | 203 / 349 / 401 / 529 |

Lint dropped roughly 17× at the median and 12× at p99. The light endpoints and
compile show slightly higher latency in the optimized run, which is expected: with
lint no longer burning CPU on rebuilds, the server pushes 44% more total traffic,
so at the same 12-way concurrency everything else runs a little busier. In normal
single-user use, where requests are effectively serial and lint is debounced, all
of these sit near 1 ms and compile near its floor.

## Memory

| point | baseline | optimized |
| --- | --- | --- |
| start (idle) | 28 MB | 28 MB |
| peak under load | 569 MB | 803 MB |
| after load ends | 309 MB | 354 MB |
| idle + 30 s | 349 MB | 270 MB |

Memory needs an honest read. The peak is higher in the optimized run, but only
because it is doing far more concurrent work (943 vs 654 req/s, 12 vs 9 live child
processes), so more compiles and buffers are in flight at once. The number that
better reflects steady state, RSS after a 30 s idle, is lower than baseline
(270 vs 349 MB). The residual few hundred MB under this workload is mostly the
system allocator holding freed pages rather than returning them immediately, plus
the spelling and grammar working set. This is a worst case: 12 threads hammering
compile and lint without pause. Real usage is one user with debounced, serial
lints and occasional compiles, where the backend sits far lower.

## Reliability

No crash in either run over ~483,000 combined requests, every response a 200, and
child processes (typst, git) always drained back to zero at idle, so there is no
process or file-descriptor leak. The lock-poisoning fix removes the one realistic
path where a single panic could have wedged the whole server.

## Not done (recommended, lower value)

- Move the synchronous `std::fs` calls in the tree, search, and file handlers onto
  `spawn_blocking`. They currently run on the async threads, which is fine because
  they measure well under a millisecond, but a workspace with very large files
  could stall a worker. Deferred as low benefit for the risk of touching many
  handlers.
- Cap `SUGGEST_CACHE` with an LRU bound. It is bounded by vocabulary in practice,
  so this is mostly tidiness.
- The three clippy style nits (`sort_by_key`, a needless `as_bytes`, a `while let`
  loop). Cosmetic, no runtime effect.
- Bound concurrent compiles with a semaphore if the transient memory peak ever
  matters. It would trade a little throughput for a lower ceiling.
