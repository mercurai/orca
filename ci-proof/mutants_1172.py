"""Mutants for claude-code-config#1172: an exact owner sha also allows a clean range (guard-step.sh exit-0 arm).
mutate_run.py adds MUTANTS. Each anchor occurs exactly once."""

import pathlib

STEP = pathlib.Path("config/mercurai/scripts/guard-step.sh")

EXACT = '"${ALLOWED_SHA:-}" =~ ^[0-9a-f]{40}$ && "$ALLOWED_SHA" = "$UPSTREAM_SHA"'
ARM = f'    if [[ {EXACT} ]]; then echo "allowed=true" >> "$out"; fi ;;\n'
FIRST = 'echo "allowed=false" >> "$out"\ncase "$rc" in\n'


def arm(cond):
    return f'    if [[ {cond} ]]; then echo "allowed=true" >> "$out"; fi ;;\n'


MUTANTS = {
    "never-allows-on-exit-0": (STEP, ARM, "    : ;;\n"),
    "allows-any-non-empty": (STEP, ARM, arm('-n "${ALLOWED_SHA:-}"')),
    "drops-40-hex-check": (STEP, ARM, arm('"${ALLOWED_SHA:-}" = "$UPSTREAM_SHA"')),
    "drops-equality-check": (STEP, ARM, arm('"${ALLOWED_SHA:-}" =~ ^[0-9a-f]{40}$')),
    "approval-checked-before-exit-code": (
        STEP,
        FIRST,
        f'echo "allowed=false" >> "$out"\nif [[ {EXACT} ]]; then echo "allowed=true" >> "$out"; fi\ncase "$rc" in\n',
    ),
    "unexpected-failure-becomes-success": (
        STEP,
        '  *) exit "$rc" ;;\n',
        '  *) echo "refused=false" >> "$out" ;;\n',
    ),
}
