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

/* ------------------------ PUBLIC ROUTES (no auth) ------------------------ */
app.get('/', (_req: Request, res: Response) => {
  res
    .type('text')
    .send('Butler is live. Use /health or call /apply and /run with X-Butler-Token.')
})

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true })
})

/* ------------------------ AUTH MIDDLEWARE (skip public) ------------------ */
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/' || req.path === '/health') return next()
  const token = req.header('X-Butler-Token')
  if (token !== ENV.BUTLER_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
})

/* --------------------------------- /apply -------------------------------- */
app.post('/apply', async (req: Request, res: Response) => {
  let p: ApplyReqT
  try {
    p = ApplyReq.parse(req.body)
  } catch (e: any) {
    return res.status(400).json({ error: 'invalid', details: e?.errors ?? String(e) })
  }

  const owner = p.owner || ENV.REPO_OWNER
  const repo = p.repo || ENV.REPO_NAME
  if (!owner || !repo) return res.status(400).json({ error: 'owner_repo_required' })

  try {
    const gh = ghClient()
    const baseSha = await mainSha(gh, owner, repo, p.baseBranch)
    const branch = sanitize(p.branch)
    await newBranch(gh, owner, repo, baseSha, branch)

    for (const e of p.edits) {
      if (!isPathAllowed(e.path)) {
        return res.status(403).json({ error: 'path_not_allowed', path: e.path })
      }
      // extra gate for workflow edits
      if (isWorkflowPath(e.path)) {
        const header = req.header('X-Butler-Approve-Workflows') || ''
        if (!ENV.WORKFLOW_EDIT_KEY || header !== ENV.WORKFLOW_EDIT_KEY) {
          return res.status(403).json({
            error: 'workflow_edit_blocked',
            hint: 'send X-Butler-Approve-Workflows header matching WORKFLOW_EDIT_KEY'
          })
        }
      }

      if (e.op === 'write') {
        let content =
          e.encoding === 'base64'
            ? Buffer.from(e.content, 'base64').toString('utf8')
            : e.content
        const existing = await getFile(gh, owner, repo, e.path)
        if (e.mode === 'append' && existing) content = decode(existing) + '\n' + content
        if (e.mode === 'create' && existing) continue
        await upsert(gh, owner, repo, branch, e.path, content, `chore(ai): write ${e.path}`)
      } else {
        const existing = await getFile(gh, owner, repo, e.path)
        if (!existing) return res.status(400).json({ error: 'file_not_found', path: e.path })
        const before = decode(existing)
        const after =
          (e.all ?? true) ? before.split(e.search).join(e.replace) : before.replace(e.search, e.replace)
        if (after === before) return res.status(400).json({ error: 'no_change', path: e.path })
        await upsert(gh, owner, repo, branch, e.path, after, `chore(ai): replace in ${e.path}`)
      }
    }

    const prUrl = await openPR(gh, owner, repo, branch, p.baseBranch, p.prTitle, p.prBody)
    res.json({ ok: true, prUrl })
  } catch (err: any) {
    res.status(500).json({ error: 'apply_failed', message: err.message })
  }
})

/* ---------------------------------- /run --------------------------------- */
app.post('/run', async (req: Request, res: Response) => {
  let plan: RunReqT
  try {
    plan = RunReq.parse(req.body)
  } catch (e: any) {
    return res.status(400).json({ error: 'invalid', details: e?.errors ?? String(e) })
  }

  const policy = loadPolicy()
  const repoKey = 'default'
  const results: Array<{ tool: string; action: string; ok: boolean; out?: unknown; error?: string }> = []

  for (const step of plan.steps) {
    const [tool, action = ''] = step.tool.split('.')
    if (!isAllowed(policy, repoKey, tool, action, plan.env)) {
      return res.status(403).json({ error: 'policy_block', tool, action, env: plan.env })
    }
    try {
      const out = await dispatch(req, tool, action, step.args, plan)
      results.push({ tool, action, ok: true, out })
    } catch (err: any) {
      results.push({ tool, action, ok: false, error: err.message })
      return res.status(500).json({ error: 'step_failed', tool, action, message: err.message, results })
    }
  }

  res.json({ ok: true, results })
})

/* ------------------------------ dispatch helper -------------------------- */
async function dispatch(req: Request, tool: string, action: string, args: Record<string, unknown>, _plan: RunReqT) {
  if (tool === 'github' && action === 'write_file') {
    const p = (args as any)?.path as string | undefined
    if (p && isWorkflowPath(p)) {
      const header = req.header('X-Butler-Approve-Workflows') || ''
      if (!ENV.WORKFLOW_EDIT_KEY || header !== ENV.WORKFLOW_EDIT_KEY) {
        throw new Error('workflow_edit_blocked: send X-Butler-Approve-Workflows header')
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
  if (tool === 'stripe' && action === 'read_connect_account') return stripeTools.read_connect_account(args as any)
  if (tool === 'deploy' && action === 'create_preview') return deployTools.create_preview(args as any)
  if (tool === 'email'  && action === 'send_test') return emailTools.send_test(args as any)

  throw new Error(`unknown_tool_or_action: ${tool}.${action}`)
}

/* --------------------------------- utils --------------------------------- */
function sanitize(b: string): string {
  return b.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9/_-]/g, '').slice(0, 100)
}

/* ------------------------------- start server ---------------------------- */
const PORT = process.env.PORT || 8787
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Butler v3 listening on :${PORT}`)
})
