"""Apply each evasion mutant, run the fork script tests, and require every mutant to be caught.
Restores the files after each run. Usage (worktree root): python mutate_run.py"""

import pathlib
import subprocess
import sys

SCRATCH = pathlib.Path(__file__).parent
REL = pathlib.Path(".github/workflows/fork-release-win-build.yml")
TPL = pathlib.Path(".github/workflows/fork-orcad-template.yml")
SYNC = pathlib.Path(".github/workflows/fork-sync-upstream.yml")
PUSH = pathlib.Path("config/mercurai/scripts/sync-push.sh")
OLD = [
    "workflow-env-secret",
    "gate-always",
    "gate-or-true",
    "gate-no-ref-clause",
    "step-if-first-key",
    "continue-on-error",
    "publish-clones-repo",
    "publish-third-party-action",
    "drop-preflight-ref-rule",
    "drop-tag-regex",
    "push-trigger",
    "yaml-anchor",
    "job-key-with-comment",
    "second-checkout-persists",
    "token-in-build",
    "keep-latest",
    "secret-on-hash-line",
    "quoted-job-key",
    "flow-style-job",
    "flow-style-step",
    "pipe-to-bash",
    "bash-dash-c",
    "dot-source",
    "pwsh-shell",
    "base64-decode",
]

# New mutants: (file, old, new).
NEW = {
    "cache-action-in-build": (
        REL,
        "      - name: Setup pnpm\n",
        "      - uses: actions/cache@v5\n        with:\n          path: x\n          key: k\n      - name: Setup pnpm\n",
    ),
    "cache-restore-in-template": (
        TPL,
        "      - name: Setup pnpm\n",
        "      - uses: actions/cache/restore@v5\n        with:\n          path: x\n          key: k\n      - name: Setup pnpm\n",
    ),
    "setup-node-cache-pnpm": (
        REL,
        "          node-version-file: package.json\n          package-manager-cache: false\n",
        "          node-version-file: package.json\n          cache: pnpm\n          package-manager-cache: false\n",
    ),
    "setup-node-auto-cache": (TPL, "          package-manager-cache: false\n", ""),
    "repo-install-action": (
        REL,
        "      - name: Setup pnpm\n",
        "      - uses: ./.github/actions/install-node-dependencies\n      - name: Setup pnpm\n",
    ),
    "no-electron-reset": (
        REL,
        '          echo "ELECTRON_CACHE=$RUNNER_TEMP/electron-cache" >> "$GITHUB_ENV"\n',
        "",
    ),
    "checkout-moving-ref": (
        REL,
        "          ref: ${{ needs.preflight.outputs.build_sha }}\n          persist-credentials: false\n",
        "          ref: ${{ needs.preflight.outputs.build_ref }}\n          persist-credentials: false\n",
    ),
    "template-gets-ref": (
        REL,
        "    with:\n      ref: ${{ needs.preflight.outputs.build_sha }}\n",
        "    with:\n      ref: ${{ needs.preflight.outputs.build_ref }}\n",
    ),
    "template-accepts-any-ref": (
        TPL,
        '          if [[ ! "$TEMPLATE_REF" =~ ^[0-9a-f]{40}$ ]]; then\n',
        "          if false; then\n",
    ),
    "sync-force-tags": (
        PUSH,
        '    if [ "${#refspecs[@]}" -gt 0 ]; then git push origin "${refspecs[@]}"; fi\n    # Stable tags win',
        "    git push --force origin --tags\n    # Stable tags win",
    ),
    "sync-plus-refspec": (
        PUSH,
        'refspecs+=("refs/upstream-tags/$tag:refs/tags/$tag")',
        'refspecs+=("+refs/upstream-tags/$tag:refs/tags/$tag")',
    ),
    "sync-fetch-over-tags": (
        SYNC,
        "          git fetch --no-tags --force upstream '+refs/tags/*:refs/upstream-tags/*'\n",
        "          git fetch upstream --tags --force\n          git fetch --no-tags --force upstream '+refs/tags/*:refs/upstream-tags/*'\n",
    ),
    "sync-mirror-mercurai": (
        pathlib.Path("config/mercurai/scripts/list-new-tags.sh"),
        "  | (grep -E ' v[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$' || true) | sort -k2 > \"$state/upstream-tags\"\n",
        '  | sort -k2 > "$state/upstream-tags"\n',
    ),
    "sync-push-all-upstream": (
        PUSH,
        'done < "$state/tags-new"',
        "done < <(awk '{print $2}' /tmp/upstream-tags)",
    ),
}

sys.path.insert(0, str(SCRATCH))
from mutants_sec201 import ASM, REB, MUTANTS as SEC201  # noqa: E402

from mutants_pr40 import MUTANTS as PR40  # noqa: E402

from mutants_1148 import MUTANTS as M1148  # noqa: E402
from mutants_1148b import DROP as DROP_1148, MUTANTS as M1148B  # noqa: E402

from mutants_1148d import DROP as DROP_1148D, MUTANTS as M1148D  # noqa: E402

M1148 = {name: mutant for name, mutant in M1148.items() if name not in DROP_1148}
M1148.update(M1148B)
M1148 = {name: mutant for name, mutant in M1148.items() if name not in DROP_1148D}
M1148.update(M1148D)
from mutants_1148e import DROP as DROP_1148E, MUTANTS as M1148E  # noqa: E402

M1148 = {name: mutant for name, mutant in M1148.items() if name not in DROP_1148E}
M1148.update(M1148E)
from mutants_1172 import MUTANTS as M1172  # noqa: E402

NEW.update(SEC201)
NEW.update({f"1148-{name}": mutant for name, mutant in M1148.items()})
NEW.update({f"pr40-{name}": mutant for name, mutant in PR40.items()})
NEW.update({f"1172-{name}": mutant for name, mutant in M1172.items()})
from mutants_1123 import MUTANTS as M1123  # noqa: E402

NEW.update({f"1123-{name}": mutant for name, mutant in M1123.items()})
print(f"1123 inventory ({len(M1123)}): {', '.join(M1123)}", flush=True)


ANCHORS_ONLY = "--anchors-only" in sys.argv


def run_tests():
    if ANCHORS_ONLY:
        return 1
    r = subprocess.run(
        ["node", "--test", "config/mercurai/scripts/*.test.mjs"],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        return r.returncode
    # The script mutants are caught by the throwaway-repo harness, not by the workflow pins.
    return subprocess.run(
        ["bash", "config/mercurai/scripts/test-fork-series-scripts.sh"],
        capture_output=True,
        text=True,
    ).returncode


files = sorted({REL, TPL, SYNC, ASM, REB, *(f for f, _, _ in NEW.values())}, key=str)
saved = {f: f.read_bytes() for f in files}
assert ANCHORS_ONLY or run_tests() == 0, "baseline fails"
print("baseline passing (unmutated)", flush=True)
escaped, unapplied = [], []
try:
    for m in OLD:
        r = subprocess.run(
            [sys.executable, str(SCRATCH / "mutate_release.py"), str(REL), m]
        )
        if r.returncode != 0:
            unapplied.append(m)
        elif run_tests() == 0:
            escaped.append(m)
        REL.write_bytes(saved[REL])
    for m, (f, a, b) in NEW.items():
        text = saved[f].decode("utf-8")
        if text.count(a) != 1:
            unapplied.append(m)
            continue
        f.write_bytes(text.replace(a, b, 1).encode("utf-8"))
        if run_tests() == 0:
            escaped.append(m)
        f.write_bytes(saved[f])
finally:
    for f in files:
        f.write_bytes(saved[f])
total = len(OLD) + len(NEW)
print(
    f"mutants {total}: caught {total - len(escaped) - len(unapplied)}, escaped {escaped}, unapplied {unapplied}"
)
sys.exit(1 if escaped or unapplied else 0)
