# Benchboard

Public benchmark history and comparisons for TIR, with authenticated nightly submissions and a credential-free candidate gate. Compile time, runtime, and microbenchmarks share one run format. Clang and GCC remain separate compiler dimensions.

The UI is a Vite/TypeScript static site on Cloudflare Pages. A separate Cloudflare Worker validates requests and stores immutable runs in D1. There is no token in the browser bundle. D1 keeps the complete normalized measurements, samples, and source provenance in one atomic row per run, with indexes for history and baseline lookup.

## Run locally

Use Node 24 or newer.

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run api:dev
```

In another terminal:

```sh
npm run dev
```

Open `http://127.0.0.1:5173/` to view submitted runs. The dashboard uses compact Changes, Trends and Results views. Select a suite and metric, compare revisions, and open row details for history and provenance.

For Cachegrind runs, the default metric is instructions executed. Cache and branch counts are simulated event counts, not elapsed time. The dashboard names each counter and shows Clang/GCC reference rows and ratios when the run includes them.

The dashboard reads the API directly. An empty database shows an empty state. The selected view persists in the URL and browser storage. Set `VITE_API_URL` before building to change the API origin.

For access from other machines on your tailnet, initialize D1 first, then run `npm run dev:tailscale`. It binds both services to the Tailscale IPv4 address and configures the browser to use the same hostname for the API. The CLI accepts trusted private HTTP endpoints only with `BENCHBOARD_ALLOW_HTTP=1`.

To exercise production static serving locally:

```sh
npm run build
npm run pages:dev
```

Pages runs on port 8788; the independent API remains on 8787. These are separate deployments, so Pages has no D1 binding or write secret. Wrangler uses `.wrangler` for local database state. If your sandbox prevents Wrangler from writing its log directory, set `WRANGLER_LOG_PATH` to a writable file.

## Import and submit

TIR's current `cargo bench` targets use `tir-bench`, a custom harness. Import its authoritative schema-3 `results.json`, not the smaller BMF summary, because the JSON includes completion status and measurement identity. Only complete reports are accepted. Pass multiple `--input` options to combine bundles from the same invocation into one run.

```sh
npm run cli -- import-tir \
  --input /path/to/programs/bundle/results.json \
  --input /path/to/functions/bundle/results.json \
  --id nightly-123 --project tir --commit COMMIT_SHA --branch master \
  --kind nightly --machine dedicated-x86-1 --config native-v1 \
  --timestamp 2026-09-24T04:30:00Z --output run.json

BENCHBOARD_URL=http://localhost:8787 \
BENCHBOARD_TOKEN=replace-with-a-random-local-token \
npm run cli -- submit --run run.json
```

Set secrets in your shell or CI secret store for real use. Reusing a run ID with identical content succeeds without adding a second run; changed content returns HTTP 409. Keep the same timestamp when retrying. Use a new ID for a new measurement attempt.

The importer fingerprints the source measurement contract into `config`. It retains engine, environment, workload and compiler reference identity while excluding the candidate compiler's changing binary provenance. Do not mix native timings and Cachegrind counts. Diagnostic metrics and Clang/GCC controls are visible without overriding the source harness's gate roles.

## Criterion

For independent Criterion.rs benchmarks, run only the intended bench target and use a fresh output directory so stale `new` results cannot enter the run:

```sh
CARGO_TARGET_DIR=target/criterion-ci cargo bench --bench YOUR_CRITERION_TARGET
npm run cli -- import-criterion --input target/criterion-ci/criterion --compiler tir \
  --id criterion-123 --project tir --commit COMMIT_SHA --branch master \
  --kind nightly --machine dedicated-x86-1 --config criterion-v1 \
  --timestamp 2026-09-24T04:30:00Z --output criterion-run.json
```

Remove or replace that target directory before the next collection. Import happens only after Cargo exits successfully. The adapter reads `new/estimates.json`, `benchmark.json`, and optional `sample.json`; it records the mean, confidence bounds, and per-iteration samples. It supports Criterion's default wall-time measurement in nanoseconds, not custom `Measurement` units or cargo-criterion's separate output format. Cargo builds and invokes the benchmark harness; it does not itself aggregate these report files. Keep independent Criterion collections under a separate config, or combine benchmark targets in one import. The dashboard labels the shared function-benchmark suite as Microbenchmarks and records whether its source was TIR or Criterion.

## Regression gates

```sh
BENCHBOARD_URL=https://YOUR_API.workers.dev \
npm run cli -- check --run candidate.json --branch master --threshold 5
```

Exit codes are `0` for pass, `1` for regression or missing required measurements, and `2` for no compatible baseline, incomparable data, or an operational error. The public check endpoint does not store candidates. It selects the latest nightly matching project, baseline branch, machine and config. It compares suite, benchmark, compiler, metric and unit. Missing gated rows fail. Reference rows remain visible without deciding the gate. New rows have no historical delta. A zero gated baseline is incomparable.

Thresholds are arithmetic percentage increases, not statistical significance tests. Samples and Criterion confidence bounds remain inspectable. The default threshold is 5%; choose a threshold appropriate for your runner. The dashboard's ratios divide TIR/FCC by a matching Clang/GCC value. A ratio above 1 means TIR/FCC used more time, instructions or memory.

## TIR CI

`examples/tir/.github/workflows/benchboard.yaml` and its collection script provide nightly publication and pull-request gating. They measure Dhrystone and CoreMark compile/runtime behavior with FCC, Clang and GCC, plus PBQP microbenchmarks. This is an initial workload selection, not every TIR target. The existing Cachegrind nightly can continue independently.

Before enabling the workflow:

1. Publish this repository and set `BENCHBOARD_REPOSITORY` to its `owner/repository` and `BENCHBOARD_REF` to a reviewed immutable commit SHA.
2. Configure an isolated Linux runner with the `benchboard` label, Rust, Clang, GCC, Python 3, `/usr/bin/time`, and benchmark build prerequisites. Reserve an allowed CPU and avoid concurrent workloads. Use disposable runners for untrusted PR code, preserving the same controlled hardware, hostname and CPU configuration for comparable native results.
3. Set repository variables `BENCHBOARD_URL`, `BENCHBOARD_CPU`, and `BENCHBOARD_MACHINE`.
4. Create the `benchmark-runner` environment with approval controls suitable for PR code. Do not place secrets in that environment. Configure `benchmark-publish` for trusted default-branch jobs and store its `BENCHBOARD_TOKEN` secret.
5. Copy the workflow to TIR's `.github/workflows/benchboard.yaml`. Set `BENCHBOARD_ENABLED=true` after runner setup, then dispatch a trusted `master` run to establish the first baseline.
6. Make the `Benchboard / measure` check required once a compatible baseline exists.

A separate hosted publish job downloads the successful nightly artifact, compares it with its predecessor, and submits it. Regressed nightlies are retained for diagnosis and fail the publish job; a missing compatible baseline starts a new history. PR jobs receive no submission credential. The workflow hashes harness, workload and toolchain inputs into the configuration; changing them requires a new compatible nightly. A disabled or unconfigured workflow does not establish a working gate. Benchmark artifacts are uploaded even when measurement or comparison fails.

The same CLI check works in a local pre-commit hook, provided the local machine/config matches the nightly runner. A laptop cannot meaningfully gate against another machine's native timing baseline.

## Deploy to Cloudflare

Pushes to `master` run tests, then deploy D1, the Worker API and the Pages frontend. Pull requests run tests only. Production deployments are serialized so database migrations and Worker secrets cannot race.

Configure these repository Actions secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Destination account ID |
| `CLOUDFLARE_API_TOKEN` | Account-scoped token with Workers Scripts Edit, D1 Edit and Cloudflare Pages Edit |
| `BENCHBOARD_SUBMIT_TOKEN` | Random credential for nightly submissions |
| `BENCHBOARD_CANDIDATE_TOKEN` | Separate random credential for storing candidates |

Set the repository Actions variable `BENCHBOARD_API_URL` to `https://benchboard-api.terantamoulamp.workers.dev`. Providing the origin directly lets the CI token stay scoped to this Worker without account-wide Workers read access.

The deployment script finds or creates the D1 database named `benchboard`, applies pending migrations, deploys `benchboard-api`, and synchronizes its two submission secrets. It then finds or creates the Pages project `benchboard` with production branch `master`, builds the UI with the deployed API URL, publishes it, and checks both public endpoints. URLs appear in the Actions job summary. Repeating deployment reuses the same database and applies only new migrations.

`wrangler.jsonc` is the Pages configuration. Worker commands use `wrangler.api.jsonc` explicitly. The automated deployment resolves the production database ID into an ignored generated configuration, leaving the local development database separate. To deploy the same way from a terminal, provide the four secrets and `BENCHBOARD_API_URL` as environment variables and run `npm run deploy`.

Use a dedicated API token for CI. A Wrangler OAuth login can deploy interactively but does not grant API-token management permission. Store the API token as a GitHub secret, never in this repository. Configure custom domains in Cloudflare if needed.

Read and check routes are public with CORS support. Submission routes require their respective bearer credential. Configure Cloudflare request-rate limits for public API traffic before broad exposure.

Runs are bounded to 1 MB per submission and 10,000 measurements, with 1,000 samples per measurement. Metadata nesting is bounded. Paginated history avoids loading the whole archive. This initial design stores immutable run documents rather than a metric warehouse; benchmark artifacts such as Cachegrind profiles stay in CI artifacts. Back up D1 through Cloudflare's D1 facilities and review retention as the archive grows.

## Verify

```sh
npm run typecheck
npm test
npm run build
npm run test:integration
npx wrangler deploy --dry-run --config wrangler.api.jsonc
```

The integration test uses the actual Worker runtime and local D1, including authorization, persistence, immutable retries, baseline selection and CLI exit codes. It needs permission to bind loopback ports. No test deploys cloud resources.

References: [Pages local development](https://developers.cloudflare.com/pages/functions/local-development/), [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [Criterion command-line options](https://criterion-rs.github.io/book/user_guide/command_line_options.html). Layout references: [rustc performance](https://perf.rust-lang.org/), [Bencher](https://bencher.dev/docs/), and [LNT](https://llvm.org/docs/lnt/).
