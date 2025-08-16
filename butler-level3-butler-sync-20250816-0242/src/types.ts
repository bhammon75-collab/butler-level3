import { z } from 'zod'

export const EditReplace = z.object({
  op: z.literal('replace'),
  path: z.string(),
  search: z.string(),
  replace: z.string(),
  isRegex: z.boolean().optional().default(false),
  all: z.boolean().optional().default(true)
})
export const EditWrite = z.object({
  op: z.literal('write'),
  path: z.string(),
  content: z.string(),
  encoding: z.enum(['utf8','base64']).optional().default('utf8'),
  mode: z.enum(['create','overwrite','append']).optional().default('overwrite')
})
export const Edits = z.array(z.union([EditReplace, EditWrite]))

export const ApplyReq = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  baseBranch: z.string().optional().default('main'),
  branch: z.string(),
  prTitle: z.string(),
  prBody: z.string().optional().default(''),
  edits: Edits
})
export type ApplyReqT = z.infer<typeof ApplyReq>

export const PlanStep = z.object({
  tool: z.string(),    // e.g. "github.write_file"
  args: z.record(z.any())
})
export const RunReq = z.object({
  repo: z.string(),
  branch: z.string(),
  env: z.enum(['staging','prod']).default('staging'),
  dryRun: z.boolean().optional().default(false),
  steps: z.array(PlanStep).min(1)
})
export type RunReqT = z.infer<typeof RunReq>
