import express from 'express'
import { ENV } from './lib/env'
import { isPathAllowed } from './lib/allowlist'
import { ghClient, mainSha, newBranch, getFile, decode, upsert, openPR } from './lib/github'
import { ApplyReq, ApplyReqT, RunReq, RunReqT } from './types'
import { loadPolicy, isAllowed } from './policy'
import { githubTools } from './adapters/github'
import { supabaseTools } from './adapters/supabase'
import { stripeTools } from './adapters/stripe'
import { deployTools } from './adapters/deploy'
import { emailTools } from './adapters/email'

const app = express()
app.use(express.json({ limit: '1mb' }))

// Simple shared-secret auth for every request
app.use((req, res, next) => {
  if (req.header('X-Butler-Token') !== ENV.BUTLER_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
})

app.get('/health', (_req, res) => res.json({ ok: true }))

// LEVEL-1: /apply (open a PR with file edits)
app.post('/apply', async (req, res) => {
  let p: ApplyReqT
  try { p = ApplyReq.parse(req.body) } catch (e:any) {
    return res.status(400).json({ error:'invalid', details:e.errors })
  }

  const owner = p.owner || ENV.REPO_OWNER
  const repo  = p.repo  || ENV.REPO_NAME
  if (!owner || !repo) return res.status(400).json({ error:'owner_repo_required' })

  const gh = ghClient()
  const baseSha = await mainSha(gh, owner, repo, p.baseBranch)
  const branch = sanitize(p.branch)
  await newBranch(gh, owner, repo, baseSha, branch)

  for (const e of p.edits) {
    if (e.op === 'write') {
      if (!isPathAllowed(e.path)) return res.status(403).json({ error:'path_not_allowed', path:e.path })
      let content = e.encoding === 'base64' ? Buffer.from(e.content, 'base64').toString('utf8') : e.content
      const existing = await getFile(gh, owner, repo, e.path)
      if (e.mode === 'append' && existing) content = decode(existing) + '\n' + content
      if (e.mode === 'create' && existing) continue
      await upsert(gh, owner, repo, branch, e.path, content, `chore(ai): write ${e.path}`)
    } else {
      const existing = await getFile(gh, owner, repo, e.path)
      if (!existing) return res.status(400).json({ error:'file_not_found', path:e.path })
      const before = decode(existing)
      const after  = (e.all ?? true) ? before.split(e.search).join(e.replace) : before.replace(e.search, e.replace)
      if (after === before) return res.status(400).json({ error:'no_change', path:e.path })
      await upsert(gh, owner, repo, branch, e.path, after, `chore(ai): replace in ${e.path}`)
    }
  }

  const prUrl = await openPR(gh, owner, repo, branch, p.baseBranch, p.prTitle, p.prBody)
  res.json({ ok:true, prUrl })
})

// LEVEL-3: /run (execute a multi-tool plan with simple policy checks)
app.post('/run', async (req, res) => {
  let plan: RunReqT
  try { plan = RunReq.parse(req.body) } catch (e:any) {
    return res.status(400).json({ error:'invalid', details:e.errors })
  }

  const policy = loadPolicy()
  const repoKey = 'default' // simple starter: one rule set

  const results:any[] = []
  for (const step of plan.steps) {
    const [tool, action] = step.tool.split('.')
    if (!isAllowed(policy, repoKey, tool, action, plan.env)) {
      return res.status(403).json({ error:'policy_block', tool, action, env: plan.env })
    }
    try {
      const out = await dispatch(tool, action, step.args, plan)
      results.push({ tool, action, ok: true, out })
    } catch (err:any) {
      results.push({ tool, action, ok: false, error: err.message })
      return res.status(500).json({ error:'step_failed', tool, action, message: err.message, results })
    }
  }
  res.json({ ok:true, results })
})

async function dispatch(tool:string, action:string, args:any, _plan: RunReqT) {
  if (tool === 'github') {
    if (action === 'create_branch') return githubTools.create_branch(args)
    if (action === 'write_file')   return githubTools.write_file(args)
    if (action === 'open_pr')      return githubTools.open_pr(args)
  }
  if (tool === 'supabase') {
    if (action === 'deploy_function')  return supabaseTools.deploy_function(args)
    if (action === 'set_function_env') return supabaseTools.set_function_env(args)
    if (action === 'invoke_rpc')       return supabaseTools.invoke_rpc(args)
    if (action === 'sql_migrate')      return supabaseTools.sql_migrate(args)
  }
  if (tool === 'stripe') {
    if (action === 'read_connect_account') return stripeTools.read_connect_account(args)
  }
  if (tool === 'deploy') {
    if (action === 'create_preview') return deployTools.create_preview(args)
  }
  if (tool === 'email') {
    if (action === 'send_test') return emailTools.send_test(args)
  }
  throw new Error(`unknown_tool_or_action: ${tool}.${action}`)
}

function sanitize(b:string) { return b.trim().replace(/\s+/g,'-').replace(/[^a-zA-Z0-9/_-]/g,'').slice(0,100) }

const PORT = process.env.PORT || 8787
app.listen(PORT, () => console.log(`Butler v3 listening on :${PORT}`))
