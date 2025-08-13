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

  // Defaults for target repo (can be overridden in requests)
  REPO_OWNER: process.env.REPO_OWNER || '',
  REPO_NAME: process.env.REPO_NAME || '',

  // API auth
  BUTLER_TOKEN: need('BUTLER_TOKEN'),

  // Extra approval required to edit .github/workflows/*
  // When set, callers MUST send header: X-Butler-Approve-Workflows: <WORKFLOW_EDIT_KEY>
  WORKFLOW_EDIT_KE
