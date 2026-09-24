#!/usr/bin/env bash
set -euo pipefail
: "${BENCHBOARD_URL:?Set the public HTTPS benchmark API URL}"
: "${BENCHBOARD_CPU:?Set a CPU reserved for benchmark execution}"
: "${BENCHBOARD_MACHINE:?Set a stable runner identity}"
: "${BENCHBOARD_CLI:?Set the path to the checked-out benchboard cli/main.ts}"
: "${BENCHBOARD_TSX:?Set the path to benchboard node_modules/.bin/tsx}"
: "${BENCHBOARD_COMMIT:?Set the measured commit}"
: "${BENCHBOARD_RUN_ID:?Set a unique run ID}"
: "${BENCHBOARD_KIND:?Set nightly or candidate}"
: "${BENCHBOARD_BRANCH:?Set the measured branch}"
# A fresh directory prevents ingestion of stale successful bundles after failures.
result_dir=$(mktemp -d "$PWD/benchboard-results.XXXXXX")
export CARGO_INCREMENTAL=0
cargo bench --locked -p fcc --bench programs -- \
  --engine native --phase all --samples 5 --cpu "$BENCHBOARD_CPU" \
  --compiler fcc,clang,gcc --level O2 \
  --filter '{fcc,clang,gcc}/{dhrystone,coremark}/source/O2/*' \
  --min-cases 30 --output "$result_dir/programs"
cargo bench --locked -p tir-pbqp --bench pbqp -- \
  --engine native --samples 15 --cpu "$BENCHBOARD_CPU" \
  --filter dense_search/16 --min-cases 1 --output "$result_dir/functions"
# Include harness/workload and toolchain identities, excluding the candidate compiler source.
config_digest=$({
  git ls-files -z Cargo.toml Cargo.lock utils/bench benchmarks/programs utils/pbqp/benches .github/scripts/benchboard-run.sh | sort -z | xargs -0 sha256sum
  rustc -vV
  clang --version
  gcc --version
  uname -srmo
} | sha256sum | cut -d ' ' -f1)
mapfile -d '' reports < <(find "$result_dir" -name results.json -print0 | sort -z)
[ "${#reports[@]}" -eq 2 ] || { echo 'Expected exactly two complete TIR report bundles' >&2; exit 2; }
inputs=()
for report in "${reports[@]}"; do inputs+=(--input "$report"); done
"$BENCHBOARD_TSX" "$BENCHBOARD_CLI" import-tir \
  --id "$BENCHBOARD_RUN_ID" --project tir --commit "$BENCHBOARD_COMMIT" \
  --branch "$BENCHBOARD_BRANCH" --kind "$BENCHBOARD_KIND" \
  --machine "$BENCHBOARD_MACHINE" --config "native-v1-$config_digest" \
  --timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --output benchboard-run.json "${inputs[@]}"
