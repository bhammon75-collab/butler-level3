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
            :
