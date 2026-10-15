"""SEC-201 evasion mutants for fork-assemble-release and fork-rebase-patches: (file, old, new)."""

import pathlib

ASM = pathlib.Path(".github/workflows/fork-assemble-release.yml")
REB = pathlib.Path(".github/workflows/fork-rebase-patches.yml")
DEFAULT_REF = "github.ref == format('refs/heads/{0}', github.event.repository.default_branch || 'mercurai')"

MUTANTS = {
    "asm-secret-in-test": (
        ASM,
        "      - name: Tests named by the series\n",
        "      - name: Tests named by the series\n        env:\n          X: ${{ secrets.FORK_BOT_TOKEN }}\n",
    ),
    "asm-workflow-gh-token": (
        ASM,
        "  TAG: ${{ inputs.tag }}\n",
        "  TAG: ${{ inputs.tag }}\n  GH_TOKEN: ${{ secrets.FORK_BOT_TOKEN }}\n",
    ),
    "asm-push-runs-vitest": (
        ASM,
        '          echo "tested tree $tree; release tag $TESTED_TAG"\n',
        "          pnpm exec vitest run\n",
    ),
    "asm-push-gate-needs": (
        ASM,
        "    if: ${{ " + DEFAULT_REF + " && !inputs.dry_run }}\n",
        "    if: ${{ needs.test.outputs.tree != '' }}\n",
    ),
    "asm-no-tree-check": (
        ASM,
        '          if [ "$tree" != "$TESTED_TREE" ] || [ "$branch" != "$TESTED_BRANCH" ]; then\n',
        "          if false; then\n",
    ),
    "asm-checkout-token": (
        ASM,
        "          persist-credentials: false\n\n      # Assembled again here, from git alone",
        "          token: ${{ secrets.FORK_BOT_TOKEN }}\n\n      # Assembled again here, from git alone",
    ),
    "reb-cache-in-test": (
        REB,
        "      - name: Setup pnpm\n",
        "      - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4\n"
        "        with:\n          path: x\n          key: k\n      - name: Setup pnpm\n",
    ),
    "reb-repo-install-action": (
        REB,
        "      - name: Setup pnpm\n",
        "      - uses: ./.github/actions/install-node-dependencies\n      - name: Setup pnpm\n",
    ),
    "reb-push-gate-tested": (
        REB,
        "    if: ${{ !cancelled() && inputs.tag != '' && !inputs.dry_run && "
        + DEFAULT_REF
        + " }}\n",
        "    if: ${{ !cancelled() && needs.test.outputs.failed == '0' }}\n",
    ),
    "reb-no-tree-check": (
        REB,
        '            if ! grep -qxF "$branch $tree $before" <<<"$TESTED_TREES"; then\n',
        "            if false; then\n",
    ),
    "reb-ignore-test-result": (
        REB,
        '          if [ "$TEST_RESULT" != success ] || [ "$TEST_FAILED" != 0 ] || [ -s /tmp/conflicted ]; then failed=1; fi\n',
        "          if [ -s /tmp/conflicted ]; then failed=1; fi\n",
    ),
    "reb-git-config-token": (
        REB,
        '          bash /tmp/fork-scripts/rebase-series.sh\n          git checkout -q "$FORK_BRANCH"\n',
        "          bash /tmp/fork-scripts/rebase-series.sh\n"
        '          git config http.https://github.com/.extraheader "AUTHORIZATION: basic $X"\n'
        '          git checkout -q "$FORK_BRANCH"\n',
    ),
    "reb-push-pnpm": (
        REB,
        '          bash /tmp/fork-scripts/rebase-series.sh\n          git checkout -q "$FORK_BRANCH"\n',
        '          bash /tmp/fork-scripts/rebase-series.sh\n          npx something\n          git checkout -q "$FORK_BRANCH"\n',
    ),
}
