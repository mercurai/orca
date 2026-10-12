"""Evasion mutants for the pins added in PR 40: (file, old, new). Each anchor must occur exactly once;
mutate_run.py counts a mutant whose anchor is missing or repeated as a failure, never a skip."""

import pathlib

SYNC = pathlib.Path(".github/workflows/fork-sync-upstream.yml")
REL = pathlib.Path(".github/workflows/fork-release-win-build.yml")
TPL = pathlib.Path(".github/workflows/fork-orcad-template.yml")
S = pathlib.Path("config/mercurai/scripts")
ASM_SH = S / "assemble-release.sh"
REB_SH = S / "rebase-series.sh"
PUSH_SH = S / "push-rebased-series.sh"
FETCH_SH = S / "fetch-rebase-inputs.sh"

PIN = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0"
PERSIST = "          persist-credentials: false\n"
SECRET = "${{ secrets.FORK_BOT_TOKEN }}"
PREFIX_CHECK_BRANCH = (
    '[[ "$branch" =~ ^patch/[A-Za-z0-9._-]+$ && "$branch" != *..* ]] ||'
)
MERGE_TOKEN = (
    "          # Empty on a report-only run, which pushes nothing.\n"
    "          GH_TOKEN: ${{ steps.mode.outputs.push == 'true' && secrets.FORK_BOT_TOKEN || '' }}\n"
)
HAND_IF = (
    "        if: ${{ steps.mode.outputs.push == 'true' && steps.guard.outputs.refused == 'false' && "
    "steps.tags.outputs.rebase_tag != '' }}\n"
)
FORK_TAG_FETCH = (
    'git fetch --no-tags origin "+refs/tags/$TARGET:refs/tags/$TARGET" ||\n'
    '  { echo "::error::the fork has no tag $TARGET; fork-sync-upstream mirrors it first"; exit 1; }\n'
)
LATEST_CR = (
    "          sed 's/\\r$//' dist/latest.yml | LC_ALL=C grep -q $'\\r' && ok=false\n"
)
LATEST_NUL = (
    "          tr -d '\\000' < dist/latest.yml | cmp -s - dist/latest.yml || ok=false\n"
)
MANIFEST_EXIT = (
    "            printf 'found:\\n'; cat dist/latest.yml\n            exit 1\n"
)

MUTANTS = {
    # fork-sync-upstream token scope
    "sync-workflow-gh-token": (
        SYNC,
        "  SYNC_ISSUE_LABEL: fork-sync\n",
        f"  SYNC_ISSUE_LABEL: fork-sync\n  GH_TOKEN: {SECRET}\n",
    ),
    "sync-persist-credentials-true": (
        SYNC,
        PERSIST,
        "          persist-credentials: true\n",
    ),
    "sync-persist-credentials-omitted": (SYNC, PERSIST, ""),
    "sync-unpinned-checkout": (SYNC, PIN, "actions/checkout@v4"),
    "sync-checkout-token": (SYNC, PERSIST, f"{PERSIST}          token: {SECRET}\n"),
    "sync-permissions-write": (
        SYNC,
        "permissions:\n  contents: read\n",
        "permissions:\n  contents: write\n",
    ),
    "sync-secret-in-fetch-step": (
        SYNC,
        "        id: fetch\n        run: |\n",
        f"        id: fetch\n        env:\n          X: {SECRET}\n        run: |\n",
    ),
    "sync-persisted-extraheader": (
        SYNC,
        "          bash config/mercurai/scripts/sync-push.sh main\n",
        '          git config http.https://github.com/.extraheader "AUTHORIZATION: basic $auth"\n'
        "          bash config/mercurai/scripts/sync-push.sh main\n",
    ),
    "sync-hand-step-without-token": (
        SYNC,
        f"{HAND_IF}        env:\n          GH_TOKEN: {SECRET}\n",
        HAND_IF,
    ),
    "sync-merge-token-on-report-only": (
        SYNC,
        MERGE_TOKEN,
        f"          GH_TOKEN: {SECRET}\n",
    ),
    # preflight
    "preflight-publish-always": (
        REL,
        "          publish=false\n",
        "          publish=true\n",
    ),
    "preflight-publish-ignores-dry-run": (
        REL,
        'if [ "$DRY_RUN" != "true" ] && [ "$DISPATCH_REF" = "refs/heads/$DEFAULT_BRANCH" ]; then\n',
        'if [ "$DISPATCH_REF" = "refs/heads/$DEFAULT_BRANCH" ]; then\n',
    ),
    "preflight-published-ref-build": (
        REL,
        'if [ "$publish" = "true" ] && [ -n "$REF_INPUT" ]; then\n',
        "if false; then\n",
    ),
    # smoke
    "smoke-renderer-optional": (
        REL,
        "if ($renderers.Count -eq 0) { throw ",
        "if ($false) { throw ",
    ),
    "smoke-renderer-pattern": (
        REL,
        "-match '--type=renderer'",
        "-match '--type=gpu-process'",
    ),
    # manifest check
    "manifest-no-cr-check": (REL, LATEST_CR, ""),
    "manifest-no-nul-check": (REL, LATEST_NUL, ""),
    "manifest-no-exit": (
        REL,
        MANIFEST_EXIT,
        "            printf 'found:\\n'; cat dist/latest.yml\n",
    ),
    "manifest-no-line-count": (
        REL,
        '          [ "${#found[@]}" -eq 8 ] || ok=false\n',
        "",
    ),
    # branch-prefix checks
    "asm-release-prefix-dropped": (
        ASM_SH,
        "^release/[A-Za-z0-9._-]+$ &&",
        "^[A-Za-z0-9._/-]+$ &&",
    ),
    "asm-release-dotdot-allowed": (
        ASM_SH,
        ' && "$branch" != *..* ]] || { echo "::error::release_branch',
        ' ]] || { echo "::error::release_branch',
    ),
    "asm-patch-prefix-dropped": (
        ASM_SH,
        '[[ "$patch" =~ ^patch/[A-Za-z0-9._-]+$ && "$patch" != *..* ]] ||',
        "true ||",
    ),
    "rebase-prefix-dropped": (REB_SH, PREFIX_CHECK_BRANCH, "true ||"),
    "push-prefix-dropped": (PUSH_SH, PREFIX_CHECK_BRANCH, "true ||"),
    # the rebase reads the fork's tag
    "fetch-upstream-tags": (
        FETCH_SH,
        "git fetch --no-tags upstream main\n",
        "git fetch --no-tags upstream main\ngit fetch upstream --tags --force\n",
    ),
    "fetch-fork-tag-dropped": (FETCH_SH, FORK_TAG_FETCH, ""),
    "fetch-missing-tag-silent": (
        FETCH_SH,
        FORK_TAG_FETCH,
        'git fetch --no-tags origin "+refs/tags/$TARGET:refs/tags/$TARGET" || true\n',
    ),
    # assemble reads the fork's tags only
    "asm-fetches-upstream-tags": (
        ASM_SH,
        "git fetch origin '+refs/heads/patch/*:refs/remotes/origin/patch/*' --tags\n",
        "git fetch origin '+refs/heads/patch/*:refs/remotes/origin/patch/*' --tags\ngit fetch upstream --tags --force\n",
    ),
    "asm-tag-error-dropped": (
        ASM_SH,
        ' ||\n  { echo "::error::the fork has no tag $TAG; fork-sync-upstream mirrors it first"; exit 1; }\n',
        "\n",
    ),
    # CR in printed git output
    "asm-log-keeps-cr": (
        ASM_SH,
        "\"refs/tags/$TAG..HEAD\" | tr -d '\\r'\n",
        '"refs/tags/$TAG..HEAD"\n',
    ),
    "asm-cherry-pick-keeps-cr": (ASM_SH, " 2>&1 | tr -d '\\r' ||", " ||"),
    "rebase-output-keeps-cr": (
        REB_SH,
        "</dev/null 2>&1 | tr -d '\\r'; then",
        "</dev/null; then",
    ),
    # the ships gate
    "ships-gate-wrong-version": (
        TPL,
        "FIRST_WITH_ORCAD_HOSTS: 1.4.224\n",
        "FIRST_WITH_ORCAD_HOSTS: 1.4.225\n",
    ),
    "ships-gate-fails-open": (
        TPL,
        'Assemble it with that patch."\n            exit 1\n',
        'Assemble it with that patch."\n            exit 0\n',
    ),
}
