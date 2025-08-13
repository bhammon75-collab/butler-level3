import express, { type Request, type Response, type NextFunction } from 'express'
import { ENV } from './lib/env'
import { isPathAllowed } from './lib/allowlist'
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
  const
