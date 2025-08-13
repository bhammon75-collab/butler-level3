import 'dotenv/config'

function need(name: string) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env: ${name}`)
  return v
}

export const ENV = {
  // GitHub App
  APP_ID: Number(need('APP_ID')),
  PRIVATE_KEY: (() => {
    const b64 = process.env.PRIVATE_KEY_BASE64
    if (b64) return Buffer.from(b64, 'base64').toString('utf8')
    const pem = process.env.PRIVATE_KEY
    if (!pem) throw new Error('Provide PRIVATE_KEY or PRIVATE_KEY_BASE64')
    return pem.replace(/\\n/g, '\n')
  })(),
  INSTALLATION_ID: Number(need('INSTALLATION_ID')),

  // Defaults for target repo (can be overridden per request)
  REPO_OWNER: process.env.REPO_OWNER || '',
  REPO_NAME: process.env.REPO_NAME || '',

  // API auth
  BUTLER_TOKEN: need('BUTLER_TOKEN'),

  // Extra approval required to edit .github/workflows/*
  // Callers must send header: X-Butler-Approve-Workflows: <WORKFLOW_EDIT_KEY>
  WORKFLOW_EDIT_KEY: process.env.WORKFLOW_EDIT_KEY || '',

  // Safety limits
  MAX_EDIT_COUNT: Number(process.env.MAX_EDIT_COUNT || 25),
  MAX_FILE_SIZE_BYTES: Number(process.env.MAX_FILE_SIZE_BYTES || 200000),

  // Optional tool configs (staging first)
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  SUPABASE_SERVICE_ROLE_KEY_STAGING: process.env.SUPABASE_SERVICE_ROLE_KEY_STAGING || '',
  SUPABASE_SERVICE_ROLE_KEY_PROD: process.env.SUPABASE_SERVICE_ROLE_KEY_PROD || '',

  RESEND_API_KEY_STAGING: process.env.RESEND_API_KEY_STAGING || '',
  RESEND_API_KEY_PROD: process.env.RESEND_API_KEY_PROD || '',

  VERCEL_DEPLOY_HOOK_URL: process.env.VERCEL_DEPLOY_HOOK_URL || ''
}
