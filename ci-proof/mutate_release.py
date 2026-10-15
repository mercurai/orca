"""Apply one named evasion to fork-release-win-build.yml (the reviews' SEC-003 and SEC-104 lists
plus the earlier mutants). Usage: python mutate_release.py <workflow file> <mutant>
Exit 3 when the mutant's anchor text is missing, so a caller cannot count it as caught."""

import pathlib
import sys

p = pathlib.Path(sys.argv[1])
t = p.read_bytes().decode("utf-8")
m = sys.argv[2]
NL = "\n"

GATE = (
    "    if: ${{ github.repository == 'mercurai/orca' && !inputs.dry_run && inputs.ref == '' && "
    "github.ref == format('refs/heads/{0}', github.event.repository.default_branch || 'mercurai') }}"
    + NL
)
VET_HEAD = "      - name: Vet the tag" + NL + "        run: |" + NL


def sub(a, b):
    global t
    if a not in t:
        print(f"anchor missing for {m}: {a[:60]!r}", file=sys.stderr)
        raise SystemExit(3)
    t = t.replace(a, b, 1)


if m == "workflow-env-secret":
    sub(
        "env:" + NL + "  TAG: ${{ inputs.tag }}" + NL,
        "env:"
        + NL
        + "  TAG: ${{ inputs.tag }}"
        + NL
        + "  X: ${{ secrets.FORK_BOT_TOKEN }}"
        + NL,
    )
elif m == "gate-always":
    sub(
        GATE, GATE.replace("${{ github.repository", "${{ always() || github.repository")
    )
elif m == "gate-or-true":
    sub(GATE, GATE.replace(" }}" + NL, " || true }}" + NL))
elif m == "gate-no-ref-clause":
    sub(GATE, GATE.replace(" && inputs.ref == ''", ""))
elif m == "step-if-first-key":
    sub(
        "      - name: Publish the release" + NL,
        "      - if: always()" + NL + "        name: Publish the release" + NL,
    )
elif m == "continue-on-error":
    sub(
        "      - name: Check the release files" + NL,
        "      - name: Check the release files"
        + NL
        + "        continue-on-error: true"
        + NL,
    )
elif m == "publish-clones-repo":
    sub(VET_HEAD, VET_HEAD + "          gh repo clone mercurai/orca src" + NL)
elif m == "publish-third-party-action":
    # The publish job's own download step, not build-win's (which runs the ref's code anyway).
    pinned = "        uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2"
    if pinned not in t:
        sub(pinned, "")
    head, _, tail = t.rpartition(pinned)
    t = head + "        uses: actions/download-artifact@v8" + tail
elif m == "drop-preflight-ref-rule":
    sub(
        '          if [ -n "$REF_INPUT" ] && [ "$DISPATCH_REF" = "refs/heads/$DEFAULT_BRANCH" ]; then'
        + NL,
        "          if false; then" + NL,
    )
elif m == "drop-tag-regex":
    sub(
        '          if [[ ! "$TAG" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+-mercurai\\.[0-9]+$ ]]; then'
        + NL,
        "          if false; then" + NL,
    )
elif m == "push-trigger":
    sub(
        "on:" + NL + "  workflow_dispatch:" + NL,
        "on:"
        + NL
        + "  push:"
        + NL
        + "    branches: [mercurai]"
        + NL
        + "  workflow_dispatch:"
        + NL,
    )
elif m == "yaml-anchor":
    sub(
        "    env:"
        + NL
        + "      # The runner has no checkout here; name the repos outright."
        + NL,
        "    env: &pubenv"
        + NL
        + "      # The runner has no checkout here; name the repos outright."
        + NL,
    )
elif m == "job-key-with-comment":
    sub(
        "  publish:" + NL,
        "  evil: # hidden"
        + NL
        + "    runs-on: ubuntu-latest"
        + NL
        + "    steps:"
        + NL
        + "      - run: echo ${{ secrets.FORK_BOT_TOKEN }}"
        + NL
        + NL
        + "  publish:"
        + NL,
    )
elif m == "second-checkout-persists":
    sub(
        "          sparse-checkout: config/mercurai/scripts"
        + NL
        + "          persist-credentials: false"
        + NL,
        "          sparse-checkout: config/mercurai/scripts" + NL,
    )
elif m == "token-in-build":
    head = (
        "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0"
        + NL
        + "        with:"
        + NL
        + "          ref: ${{ needs.preflight.outputs.build_sha }}"
        + NL
    )
    sub(head, head + "          token: ${{ secrets.FORK_BOT_TOKEN }}" + NL)
elif m == "keep-latest":
    sub("          rm -f dist/latest.yml dist/orca-windows-setup.exe.blockmap" + NL, "")
elif m == "secret-on-hash-line":
    sub(
        "        run: pnpm run build:release" + NL,
        "        run: |"
        + NL
        + "          # ${{ secrets.FORK_BOT_TOKEN }}"
        + NL
        + "          pnpm run build:release"
        + NL,
    )
elif m == "quoted-job-key":
    sub(
        "  publish:" + NL,
        '  "leak":'
        + NL
        + "    runs-on: ubuntu-latest"
        + NL
        + "    steps:"
        + NL
        + "      - run: echo hi"
        + NL
        + NL
        + "  publish:"
        + NL,
    )
elif m == "flow-style-job":
    sub(
        "  publish:" + NL,
        "  leak: { runs-on: ubuntu-latest, steps: [ { run: gh release list } ] }"
        + NL
        + NL
        + "  publish:"
        + NL,
    )
elif m == "flow-style-step":
    sub(VET_HEAD, "      - { name: x, run: gh release list }" + NL + VET_HEAD)
elif m == "pipe-to-bash":
    sub(VET_HEAD, VET_HEAD + "          cat x | bash" + NL)
elif m == "bash-dash-c":
    sub(VET_HEAD, VET_HEAD + '          bash -c "$X"' + NL)
elif m == "dot-source":
    sub(VET_HEAD, VET_HEAD + "          . ./x" + NL)
elif m == "pwsh-shell":
    sub(
        VET_HEAD,
        "      - name: Vet the tag"
        + NL
        + "        shell: pwsh"
        + NL
        + "        run: |"
        + NL,
    )
elif m == "base64-decode":
    sub(VET_HEAD, VET_HEAD + "          echo x | base64 -d > y" + NL)
else:
    raise SystemExit(f"unknown mutant {m}")
p.write_bytes(t.encode("utf-8"))
