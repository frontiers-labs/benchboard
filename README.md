# Benchboard

Benchboard tracks benchmark results over time without a server. A GitHub Action appends each run to a branch of your repository, compares it with the previous run, and opens an issue when a gated metric rises. A static page reads that branch and shows three views: your project against reference implementations, a compare table for two commits, and history charts.

Benchboard does not know your benchmarks. The results name their own benchmarks, metrics and variants, so adding one needs no change here.

## Record runs from CI

Your benchmark job writes one or more results files:

```json
{
  "metrics": [
    { "key": "instructions", "label": "Instructions", "unit": "count", "description": "CPU instructions executed, counted by Cachegrind. Lower is better." },
    { "key": "wall_time", "label": "Wall time", "unit": "ns" }
  ],
  "results": {
    "fcc/dhrystone/O2/run": { "instructions": { "value": 43700000000 }, "wall_time": { "value": 912000000, "lower_value": 905000000, "upper_value": 919000000 } },
    "gcc/dhrystone/O2/run": { "wall_time": { "value": 401000000 } },
    "pbqp/dense_search/16": { "instructions": { "value": 1203394 } }
  },
  "variants": {
    "fcc/dhrystone/O2/run": { "benchmark": "dhrystone/O2", "group": "Run", "variant": "fcc", "subject": true },
    "gcc/dhrystone/O2/run": { "benchmark": "dhrystone/O2", "group": "Run", "variant": "gcc", "subject": false }
  }
}
```

Only `results` is required. It maps a benchmark id to its metrics, and each metric to a `value`. `lower_value` and `upper_value` are an optional spread, shown as a percentage next to the value.

`metrics` gives a metric a readable label, a unit and a description. The page shows the description next to the values, so write it for a reader who has not seen the metric before: what was measured, how, and that lower is better. The page lists metrics in this order and formats `ns` as time, `bytes` as binary sizes, and anything else as a count. A metric without a definition is shown by its key.

`variants` marks results that measure the same benchmark in different ways, such as with different compilers. Results that share `group` and `benchmark` are compared with each other. The variant with `subject: true` is your project, and the others are its references.

Several files may report the same benchmark as long as each metric of it comes from one file. A Cachegrind job and a timing job can then cover the same ids.

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
        results: results/**/summary.json
        gate-metrics: instructions
        threshold: 2
        env-key: ${{ needs.benchmarks.outputs.environment }}
```

The concurrency group keeps two runs from pushing to the data branch at once. The checkout lets the action read the commit subject.

| Input | Default | Meaning |
| --- | --- | --- |
| `results` | required | Results files to record. Globs are allowed. |
| `gate-metrics` | none | Comma-separated metric keys that can mark the run regressed. Other metrics are recorded and shown only. |
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

A run file holds `commit`, `subject`, `time`, `run_url`, `env_key`, `gate_metrics`, `threshold`, and the merged `metrics`, `variants` and `results` of the input files.

## View the history

Open `https://frontiers-labs.github.io/benchboard/?repo=OWNER/NAME`. The page reads `index.json` and the run files from `raw.githubusercontent.com`, so the repository must be public.

| Parameter | Meaning |
| --- | --- |
| `repo` | Repository that holds the data branch. |
| `branch` | Data branch. Defaults to `perf-data`. |
| `view` | `versus`, `compare` or `history`. Defaults to `versus` when the latest run has variants. |
| `base`, `head` | Commits to compare. A prefix is enough. Defaults to the latest two runs. `versus` shows `head`. |
| `metric`, `q` | Selected metric key and benchmark name filter. |
| `data` | Base URL of a directory with the data branch layout. Use it for local data. |

The versus view answers how the subject stands against its references. For each group and metric it shows the geometric mean of subject ÷ reference with its trend over the selected runs, then a table of every benchmark with each variant's value and the ratios. All metrics count as lower is better, so a ratio above 1× means the reference is ahead. Ratios of values measured on one machine stay comparable between runs even when the machines differ.

In the compare view, click a row to see that benchmark's history. In the history view, a benchmark with variants gets one chart with a line per variant. Click a point to compare that run with the one before it.

GitHub Pages serves the page from the root of `master`. No build step runs.

## Develop

```sh
npm test                      # node --test, no dependencies
python3 -m http.server 8000   # then open http://localhost:8000/?data=/path/under/server/root/
```

`lib/compare.mjs` is shared by `record.mjs` and the page, so CI and the page classify a change the same way. `lib/versus.mjs` holds the metric definitions and the variant comparison. `publish.sh` is the script the action runs. `test/publish.test.mjs` runs it against a local bare repository.
