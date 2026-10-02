#!/usr/bin/env bash
# Record one run on the data branch. Inputs arrive as environment variables from
# action.yml. A rejected push means another run landed first, so the whole
# record step repeats against the new branch head.
set -euo pipefail
shopt -s globstar nullglob

here=$(cd "$(dirname "$0")" && pwd)
remote=${BENCHBOARD_REMOTE:-"https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"}
branch=${BENCHBOARD_DATA_BRANCH:-perf-data}
commit=${BENCHBOARD_COMMIT:?}
report=${BENCHBOARD_REPORT:?}
data=$(mktemp -d)
trap 'rm -rf "$data"' EXIT

# shellcheck disable=SC2206 # The input is a list of globs.
files=(${BENCHBOARD_RESULTS:?})
[ "${#files[@]}" -gt 0 ] || { echo "no results files match: $BENCHBOARD_RESULTS" >&2; exit 2; }
results=()
for file in "${files[@]}"; do results+=(--results "$file"); done

subject=$(git log -1 --format=%s "$commit" 2>/dev/null || true)
time=${BENCHBOARD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}

for attempt in 1 2 3; do
  rm -rf "$data"
  if git ls-remote --exit-code --heads "$remote" "$branch" >/dev/null 2>&1; then
    git clone --quiet --depth 1 --branch "$branch" "$remote" "$data"
  else
    git init --quiet --initial-branch "$branch" "$data"
    git -C "$data" remote add origin "$remote"
  fi
  node "$here/record.mjs" --data "$data" "${results[@]}" \
    --commit "$commit" --subject "$subject" --time "$time" \
    --run-url "${BENCHBOARD_RUN_URL:-}" --env-key "${BENCHBOARD_ENV_KEY:-}" \
    --gate-metrics "${BENCHBOARD_GATE_METRICS:-}" --threshold "${BENCHBOARD_THRESHOLD:-2}" \
    --repo "${GITHUB_REPOSITORY:-}" --viewer-url "${BENCHBOARD_VIEWER_URL:-}" \
    --data-branch "$branch" --report "$report"
  git -C "$data" add --all
  git -C "$data" -c user.name=benchboard -c user.email=benchboard@users.noreply.github.com \
    commit --quiet --message "Record ${commit:0:12}"
  if git -C "$data" push --quiet origin "HEAD:refs/heads/$branch"; then
    exit 0
  fi
  echo "push to $branch was rejected, retrying ($attempt)" >&2
  sleep $((attempt * 3))
done
echo "could not push to $branch" >&2
exit 1
