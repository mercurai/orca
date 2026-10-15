"""Mutants for claude-code-config#1123: a real-run override needs a manifest-pinned sha and an exactly carried
protected tree; DRY_RUN is bound to the test jobs only; record-series clears the pin. mutate_run.py adds MUTANTS.
Each anchor occurs exactly once."""

import pathlib

PARSE = pathlib.Path("config/mercurai/scripts/parse-overrides.sh")
RECORD = pathlib.Path("config/mercurai/scripts/record-series.sh")
REB = pathlib.Path(".github/workflows/fork-rebase-patches.yml")
ASM = pathlib.Path(".github/workflows/fork-assemble-release.yml")

APPLY = 'GIT_INDEX_FILE=$index git apply --cached "$diff"'
DEL_PIN = "  BRANCH=$branch yq -i 'del(.patches[] | select(.branch == strenv(BRANCH)) | .ported_head)' \"$MANIFEST_WORK\"\n"
OVERRIDE_GATE = (
    "        if: ${{ inputs.overrides != '' && github.ref == format('refs/heads/{0}', "
    "github.event.repository.default_branch || 'mercurai') && !inputs.dry_run }}\n"
)

MUTANTS = {
    # parse-overrides.sh, the parser: killed by the harness cases 31, 37 and 38 and the parser pins
    "override-regex-accepts-short-sha": (
        PARSE,
        "=([0-9a-f]{40})$ ]]",
        "=([0-9a-f]{12,40})$ ]]",
    ),
    "active-membership-removed": (
        PARSE,
        'if ! grep -qxF "$_branch" "$state/active"; then',
        "if false; then",
    ),
    "reachability-removed": (
        PARSE,
        'if ! git cat-file -e "$sha^{commit}" 2>/dev/null ||\n'
        '     [ -z "$(git for-each-ref --contains "$sha" --count=1 refs/remotes/origin/patch refs/remotes/origin/ci-only)" ]; then\n',
        "if false; then\n",
    ),
    "zero-commits-removed": (
        PARSE,
        '  [ "$(git rev-list --count "$2..$sha")" != 0 ] || { echo "::error::$1: override head $sha has no commits beyond $2"; exit 1; }\n',
        "",
    ),
    # parse-overrides.sh, the pin: harness cases p3 and p11
    "pin-skipped-when-dry-run-unset": (
        PARSE,
        'if [ "${DRY_RUN:-}" != true ]; then',
        'if [ -n "${DRY_RUN:-}" ] && [ "${DRY_RUN:-}" != true ]; then',
    ),
    "pin-skipped-when-dry-run-false": (
        PARSE,
        'if [ "${DRY_RUN:-}" != true ]; then',
        'if [ "${DRY_RUN:-}" != true ] && [ "${DRY_RUN:-}" != false ]; then',
    ),
    "pin-compared-to-any-non-empty-value": (
        PARSE,
        '  [ "$pin" = "$2" ] || {',
        '  [ -n "$pin" ] || {',
    ),
    # parse-overrides.sh, the protected tree: harness cases p6, p8, p10 and p12
    "protected-tree-check-removed": (
        PARSE,
        '    require_carried_protected_paths "$1" "$sha" "$2"\n',
        "",
    ),
    "protected-tree-limited-to-github": (
        PARSE,
        "  for path in .github config/mercurai; do",
        "  for path in .github; do",
    ),
    "protected-apply-ignores-whitespace": (
        PARSE,
        APPLY,
        'GIT_INDEX_FILE=$index git apply --cached --ignore-whitespace "$diff"',
    ),
    "empty-protected-diff-is-a-failure": (
        PARSE,
        '  if [ -s "$diff" ] && ! ' + APPLY + "; then",
        "  if ! " + APPLY + "; then",
    ),
    # record-series.sh: harness cases p1 and p2
    "record-writes-wrong-base": (
        RECORD,
        "| .base) = strenv(TARGET)'",
        '| .base) = "v0"\'',
    ),
    "record-leaves-ported-head": (RECORD, DEL_PIN, ""),
    # the workflows: the DRY_RUN node pins
    "workflow-env-sets-dry-run": (
        REB,
        "  OVERRIDES: ${{ inputs.overrides }}\n",
        "  OVERRIDES: ${{ inputs.overrides }}\n  DRY_RUN: true\n",
    ),
    "push-job-sets-dry-run": (
        REB,
        "  push:\n    needs: test\n",
        "  push:\n    needs: test\n    env:\n      DRY_RUN: true\n",
    ),
    "test-job-binds-dry-run-true": (
        REB,
        "      DRY_RUN: ${{ inputs.dry_run }}\n",
        "      DRY_RUN: true\n",
    ),
    "push-gate-dry-run-removed": (
        REB,
        "    if: ${{ !cancelled() && inputs.tag != '' && !inputs.dry_run && ",
        "    if: ${{ !cancelled() && inputs.tag != '' && ",
    ),
    "push-match-narrowed-to-branch-tree": (
        REB,
        '            if ! grep -qxF "$branch $tree $before" <<<"$TESTED_TREES"; then\n',
        '            if ! grep -qF "$branch $tree" <<<"$TESTED_TREES"; then\n',
    ),
    "live-assembly-accepts-overrides": (
        ASM,
        OVERRIDE_GATE,
        "        if: ${{ false }}\n",
    ),
}
