import express, { type Request, type Response, type NextFunction } from 'express'
import { ENV } from './lib/env'
import { isPathAllowed, isWorkflowPath } from './lib/allowlist'
import {
  ghClient,
  mainSha,
  newBranch,
  getFile,
  decode,
  upsert,
  openPR,
} from './lib/github'
import { ApplyReq, type ApplyReqT, RunReq, type RunReqT } from './types'
import { loadPolicy, isAllowed } from './policy'
import { githubTools } from './adapters/github'
import { supabaseTools } from './adapters/supabase'
import { stripeTools } from './adapters/stripe'
import { deployTools } from './adapters/deploy'
import { emailTools } from './adapters/email'

const app = express()
app.use(express.json({ limit: '1mb' }))

/** Shared-secret auth for every request */
app.use((req: Request, res: Response, next: NextFunction) => {
  const token = req.header('X-Butler-Token')
  if (token !== ENV.BUTLER_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
})

/** Health check */
app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true })
})

/** LEVEL 1: Open a PR with file edits */
app.post('/apply', async (req: Request, res: Response) => {
  let p: ApplyReqT
  try {
    p = ApplyReq.parse(req.body)
  } catch (e: unknown) {
    const zerr = e as any
    return res.status(400).json({ error: 'invalid', details: zerr?.errors ?? String(e) })
  }

  const owner = p.owner || ENV.REPO_OWNER
  const repo = p.repo || ENV.REPO_NAME
  if (!owner || !repo) {
    return res.status(400).json({ error: 'owner_repo_required' })
  }

  try {
    const gh = ghClient()
    const baseSha = await mainSha(gh, owner, repo, p.baseBranch)
    const branch = sanitize(p.branch)
    await newBranch(gh, owner, repo, baseSha, branch)

    for (const e of p.edits) {
      // ---- Gate by path allowlist
      if (!isPathAllowed(e.path)) {
        return res.status(403).json({ error: 'path_not_allowed', path: e.path })
      }
      // ---- Extra gate for workflow edits: require approval header + server key
      if (isWorkflowPath(e.path)) {
        const header = req.header('X-Butler-Approve-Workflows') || ''
        if (!ENV.WORKFLOW_EDIT_KEY || header !== ENV.WORKFLOW_EDIT_KEY) {
          return res.status(403).json({
            error: 'workflow_edit_blocked',
            hint: 'send header X-Butler-Approve-Workflows matching WORKFLOW_EDIT_KEY'
          })
        }
      }

      if (e.op === 'write') {
        let content =
          e.encoding === 'base64'
            ? Buffer.from(e.content, 'base64').toString('utf8')
            : e.content

        const existing = await getFile(gh, owner, repo, e.path)
        if (e.mode === 'append' && existing) {
          content = decode(existing) + '\n' + content
        }
        if (e.mode === 'create' && existing) {
          // skip if already exists
          continue
        }
        await upsert(
          gh, owner, repo, branch, e.path, content,
          `chore(ai): write ${e.path}`
        )
      } else {
        // Replace operation
        const existing = await getFile(gh, owner, repo, e.path)
        if (!existing) {
          return res.status(400).json({ error: 'file_not_found', path: e.path })
        }
        const before = decode(existing)
        const after =
          (e.all ?? true) === true
            ? before.split(e.search).join(e.replace)
            : before.replace(e.search, e.replace)

        if (after === before) {
          return res.status(400).json({ error: 'no_change', path: e.path })
        }
        await upsert(
          gh, owner, repo, branch, e.path, after,
          `chore(ai): replace in ${e.path}`
        )
      }
    }

    const prUrl = await openPR(gh, owner, repo, branch, p.baseBranch, p.prTitle, p.prBody)
    return res.json({ ok: true, prUrl })
  } catch (err: unknown) {
    const e = err as Error
    return res.status(500).json({ error: 'apply_failed', message: e.message })
  }
})

/** LEVEL 3: Execute a multi-tool plan with simple policy checks */
app.post('/run', async (req: Request, res: Response) => {
  let plan: RunReqT
  try {
    plan = RunReq.parse(req.body)
  } catch (e: unknown) {
    const zerr = e as any
    return res.status(400).json({ error: 'invalid', details: zerr?.errors ?? String(e) })
  }

  const policy = loadPolicy()
  const repoKey = 'default' // starter: single rule set

  const results: Array<{ tool: string; action: string; ok: boolean; out?: unknown; error?: string }> = []

  for (const step of plan.steps) {
    const dot = step.tool.indexOf('.')
    const tool = dot > -1 ? step.tool.slice(0, dot) : step.tool
    const action = dot > -1 ? step.tool.slice(dot + 1) : ''

    if (!isAllowed(policy, repoKey, tool, action, plan.env)) {
      return res
        .status(403)
        .json({ error: 'policy_block', tool, action, env: plan.env })
    }

    try {
      const out = await dispatch(req, tool, action, step.args, plan)
      results.push({ tool, action, ok: true, out })
    } catch (err: unknown) {
      const e = err as Error
      results.push({ tool, action, ok: false, error: e.message })
      return res
        .status(500)
        .json({ error: 'step_failed', tool, action, message: e.message, results })
    }
  }

  return res.json({ ok: true, results })
})

/** Dispatch a single plan step to a tool adapter (with workflow gate for /run) */
async function dispatch(req: Request, tool: string, action: string, args: Record<string, unknown>, _plan: RunReqT) {
  // If a github.write_file targets .github/workflows/*, require approval header + server key.
  if (tool === 'github' && action === 'write_file') {
    const p = (args as any)?.path as string | undefined
    if (p && isWorkflowPath(p)) {
      const header = req.header('X-Butler-Approve-Workflows') || ''
      if (!ENV.WORKFLOW_EDIT_KEY || header !== ENV.WORKFLOW_EDIT_KEY) {
        throw new Error('workflow_edit_blocked: send X-Butler-Approve-Workflows header matching WORKFLOW_EDIT_KEY')
      }
    }
  }

  if (tool === 'github') {
    if (action === 'create_branch') return githubTools.create_branch(args as any)
    if (action === 'write_file')   return githubTools.write_file(args as any)
    if (action === 'open_pr')      return githubTools.open_pr(args as any)
  }
  if (tool === 'supabase') {
    if (action === 'deploy_function')  return supabaseTools.deploy_function(args as any)
    if (action === 'set_function_env') return supabaseTools.set_function_env(args as any)
    if (action === 'invoke_rpc')       return supabaseTools.invoke_rpc(args as any)
    if (action === 'sql_migrate')      return supabaseTools.sql_migrate(args as any)
  }
  if (tool === 'stripe') {
    if (action === 'read_connect_account') return stripeTools.read_connect_account(args as any)
  }
  if (tool === 'deploy') {
    if (action === 'create_preview') return deployTools.create_preview(args as any)
  }
  if (tool === 'email') {
    if (action === 'send_test') return emailTools.send_test(args as any)
  }
  throw new Error(`unknown_tool_or_action: ${tool}.${action}`)
}

/** Normalize a branch name */
function sanitize(b: string): string {
  return b.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9/_-]/g, '').slice(0, 100)
}

const PORT = process.env.PORT || 8787
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Butler v3 listening on :${PORT}`)
})
