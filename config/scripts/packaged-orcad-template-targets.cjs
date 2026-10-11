/**
 * mercurai fork: which orcad template targets a desktop build ships. Upstream packages every
 * target; a build that sets ORCA_ORCAD_TEMPLATE_TARGETS ships only the listed ones, and a host
 * outside the list is refused by the desktop as unsupported.
 */
const { ORCAD_TEMPLATE_TARGETS } = require('../../src/shared/node-runtime-pin.ts')

const ORCAD_TEMPLATE_TARGETS_ENV = 'ORCA_ORCAD_TEMPLATE_TARGETS'

/** The variable is set but names no target, or one this version cannot build. */
class OrcadTemplateTargetsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OrcadTemplateTargetsError'
  }
}

/** The targets to verify, or undefined when unset so the verifier checks them all. */
function packagedOrcadTemplateTargets(env = process.env) {
  const raw = env[ORCAD_TEMPLATE_TARGETS_ENV]
  if (raw === undefined) {
    return undefined
  }
  const targets = raw
    .split(',')
    .map((target) => target.trim())
    .filter(Boolean)
  const unknown = targets.filter((target) => !ORCAD_TEMPLATE_TARGETS.includes(target))
  if (targets.length === 0 || unknown.length > 0) {
    throw new OrcadTemplateTargetsError(
      `${ORCAD_TEMPLATE_TARGETS_ENV} needs a comma-separated subset of ` +
        `${ORCAD_TEMPLATE_TARGETS.join(',')}; got ${unknown.length > 0 ? unknown.join(',') : 'nothing'}`
    )
  }
  return [...new Set(targets)]
}

module.exports = {
  ORCAD_TEMPLATE_TARGETS_ENV,
  OrcadTemplateTargetsError,
  packagedOrcadTemplateTargets
}
