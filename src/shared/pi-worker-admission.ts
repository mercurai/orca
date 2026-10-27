import { z } from 'zod'

const PositiveBudget = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const Price = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const ArtifactPath = z.string().min(1).max(4096).refine(
  (value) => /^(?:[a-zA-Z]:[\\/]|\/)/.test(value) && !value.includes('\0'),
  'Artifact paths must be absolute'
)

export const PiProfileSha256 = z.string().regex(/^[a-f0-9]{64}$/)

export const PiWorkerArtifactsSchema = z.object({
  sharedSource: z.object({ repo: ArtifactPath, commit: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  broker: z.object({ path: ArtifactPath, sha256: PiProfileSha256 }).strict()
}).strict()

export const PiTaskAdmissionSchema = z.object({
  taskId: z.string().min(1),
  exportTaskId: z.string().min(1),
  profileSha256: PiProfileSha256,
  templatePath: ArtifactPath.optional(),
  reviewTaskId: z.string().min(1),
  maxTokens: PositiveBudget,
  maxOutputTokens: PositiveBudget,
  maxCostMicrousd: PositiveBudget,
  deadlineUnixMs: PositiveBudget,
  endpoint: z.object({
    id: z.string().min(1),
    inputMicrousdPerMillion: Price,
    outputMicrousdPerMillion: Price
  }).strict()
}).strict().refine(
  (task) => task.maxOutputTokens <= task.maxTokens,
  'Output budget must not exceed total token budget'
).refine(
  (task) => task.endpoint.inputMicrousdPerMillion > 0 || task.endpoint.outputMicrousdPerMillion > 0,
  'At least one endpoint price must be positive'
)

export const PiWorkerAdmissionConfigSchema = z.object({
  schema: z.literal('orca.pi-worker-admission.v1'),
  maxWorkers: z.union([z.literal(2), z.literal(4)]),
  ciGateId: z.string().min(1),
  pilotGateId: z.string().min(1).optional(),
  artifacts: PiWorkerArtifactsSchema.optional(),
  tasks: z.array(PiTaskAdmissionSchema).min(1).max(256)
}).strict().refine(
  (config) => new Set(config.tasks.map((task) => task.taskId)).size === config.tasks.length,
  'Task admission entries must be unique'
).refine(
  (config) => new Set(config.tasks.map((task) => task.reviewTaskId)).size === config.tasks.length,
  'Each implementation requires its own review task'
).refine(
  (config) => new Set(config.tasks.map((task) => task.exportTaskId)).size === config.tasks.length,
  'Each implementation requires its own export task'
)

export type PiWorkerAdmissionConfig = z.infer<typeof PiWorkerAdmissionConfigSchema>
export type PiTaskAdmission = z.infer<typeof PiTaskAdmissionSchema>
