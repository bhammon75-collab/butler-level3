import { ENV } from '../lib/env'
export const deployTools = {
  async create_preview({ provider='vercel' }:{ provider?:'vercel'|'render' }) {
    if (provider === 'vercel' && ENV.VERCEL_DEPLOY_HOOK_URL) {
      await fetch(ENV.VERCEL_DEPLOY_HOOK_URL, { method: 'POST' })
      return { ok: true, url: '(check Vercel project for the new preview)' }
    }
    return { ok: true, note: 'No deploy hook configured' }
  }
}
