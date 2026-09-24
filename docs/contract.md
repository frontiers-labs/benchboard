# API contract

Canonical types are src/shared/types.ts. All measurements lower-is-better. compiler includes variant and version where needed; config identifies workload, flags and toolchain environment, stable across TIR revisions. machine identifies a controlled runner. Run IDs are stable for retries. Full submitted runs are atomic, immutable.

GET /api/runs?project=tir&limit=100 -> {runs: Run[], nextCursor: {before: string, beforeId: string} | null}, newest first. Supply both cursor fields on the next request.
GET /api/runs/:id -> Run
GET /api/baseline?project=tir&branch=master&machine=X&config=Y -> Run, 404 if absent
GET /api/compare?baseline=ID&candidate=ID&threshold=5 -> Comparison
POST /api/check?branch=master&threshold=5 body Run -> Comparison against latest matching nightly, no storage, public endpoint for untrusted CI.
POST /api/runs body Run with Authorization Bearer SUBMIT_TOKEN -> {id, duplicate}, private write. Same ID different content 409. Candidate token optional distinct CANDIDATE_TOKEN cannot write nightly. No secrets in UI.

Comparison requires exact project/machine/config, matches suite/benchmark/compiler/metric/unit. Missing baseline measurements fail closed. New rows visible, no empty success. A zero gated baseline is incomparable. Default threshold 5%, configurable 0..100, arithmetic threshold rather than statistical significance. Nightly discovery branch defaults master. Public check must never alter baseline.

UI reads API base from VITE_API_URL, localhost:8787 default. Compact Changes, Trends and Results views use one neutral style. Measurements come first, with metadata and charts on demand. UI must filter suites/compiler/benchmark, show trends and Clang/GCC ratios for same suite/benchmark/metric, compare runs and show provenance/errors/empty states.

Optional Run.metadata and Measurement.metadata preserve raw source provenance. Measurement.gate defaults true, false is display-only and must not drive failure. Import only lower-is-better metrics; diagnostic counters such as iterations/MAD/throughput are metadata, not gate rows. TIR custom function benches share the microbenchmark suite key criterion but UI labels it Microbenchmarks.
