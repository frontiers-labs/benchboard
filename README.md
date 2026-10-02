# Benchboard

Benchboard tracks benchmark results over time without a server. A GitHub Action appends each run to a branch of your repository, compares it with the previous run, and opens an issue when a gated metric rises. A static page reads that branch and shows a compare table and history charts.

Benchboard does not know your benchmarks. It records whatever benchmark and metric names appear in the results, so adding a benchmark needs no change here.

## Record runs from CI

Your benchmark job writes one or more [Bencher Metric Format](https://bencher.dev/docs/reference/bencher-metric-format/) files:

```json
{
  "fcc/dhrystone/source/O2/compile/dhry_1": { "Ir": { "value": 2394000000 } },
  "pbqp/dense_search/16": { "Ir": { "value": 1203394 }, "Dr": { "value": 301222 } }
}
```

Add a job that passes them to the action. Pin the action to a commit.

```yaml
record:
  needs: benchmarks
  runs-on: ubuntu-24.04
  permissions:
    contents: write   # push to the data branch
    issues: write     # open the regression issue
  concurrency:
    group: benchboard-record
  steps:
    - uses: actions/checkout@v7
    - uses: actions/download-artifact@v8
      with:
        path: results
    - uses: frontiers-labs/benchboard@COMMIT_SHA
      with:
        results: results/**/summary.bmf.json
        gate-metrics: Ir
        threshold: 2
        env-key: ${{ needs.benchmarks.outputs.environment }}
```

The concurrency group keeps two runs from pushing to the data branch at once. The checkout lets the action read the commit subject.

| Input | Default | Meaning |
| --- | --- | --- |
| `results` | required | BMF files to record. Globs are allowed. A benchmark may appear in only one file. |
| `gate-metrics` | none | Comma-separated metrics that can mark the run regressed. Other metrics are recorded and shown only. |
| `threshold` | `2` | Largest allowed increase of a gated metric, in percent. |
| `env-key` | none | Identity of the measurement environment, such as compiler and Valgrind versions. |
| `data-branch` | `perf-data` | Branch that stores the history. The action creates it on the first run. |
| `commit` | `github.sha` | Commit the results belong to. |
| `viewer-url` | the hosted page | Page linked from the report. |
| `issue-label` | `perf` | Label for the regression issue. Leave it empty to open no issue. |
| `token` | `github.token` | Token used to push and to open the issue. |

The action writes the comparison to the job summary and sets the outputs `regressed` and `report`.

### What counts as a regression

Each run is compared with the run recorded before it. The run is regressed when a gated metric of any benchmark rises by more than the threshold. The issue names the worst benchmark, lists every regressed and improved gated row, and links the commit range and the compare page.

Three cases are recorded without opening an issue:

- A benchmark is new or no longer reported. The report lists it.
- The `env-key` differs from the previous run. Instruction counts shift when the compiler or Valgrind changes, with no change in your project.
- Only ungated metrics moved.

Slow drift below the threshold on every run never opens an issue. The history charts show it.

Use a deterministic metric for the gate. Cachegrind instruction counts on GitHub-hosted runners vary by about 0.2% between runs. Wall time on shared runners varies far more than any useful threshold.

## Data branch layout

```
index.json                                   run list, oldest first
runs/2026-10-01T05-25-38-000Z-d46ad60a3a78.json   one file per run
```

A run file holds `commit`, `subject`, `time`, `run_url`, `env_key`, `gate_metrics`, `threshold`, and `results`. `results` is the merged BMF input.

## View the history

Open `https://frontiers-labs.github.io/benchboard/?repo=OWNER/NAME`. The page reads `index.json` and the run files from `raw.githubusercontent.com`, so the repository must be public.

| Parameter | Meaning |
| --- | --- |
| `repo` | Repository that holds the data branch. |
| `branch` | Data branch. Defaults to `perf-data`. |
| `view` | `compare` or `history`. |
| `base`, `head` | Commits to compare. A prefix is enough. Defaults to the latest two runs. |
| `metric`, `q` | Selected metric and benchmark name filter. |
| `data` | Base URL of a directory with the data branch layout. Use it for local data. |

In the compare view, click a row to see that benchmark's history. In the history view, click a point to compare that run with the one before it.

GitHub Pages serves the page from the root of `master`. No build step runs.

## Develop

```sh
npm test                      # node --test, no dependencies
python3 -m http.server 8000   # then open http://localhost:8000/?data=/path/under/server/root/
```

`lib/compare.mjs` is shared by `record.mjs` and the page, so CI and the page classify a change the same way. `publish.sh` is the script the action runs. `test/publish.test.mjs` runs it against a local bare repository.
