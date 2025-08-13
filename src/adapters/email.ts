import { ENV } from '../lib/env'
export const emailTools = {
  async send_test({ to, subject='ZingLots Butler Test', html='<p>Hello</p>', env='staging' }:{
    to:string, subject?:string, html?:string, env?:'staging'|'prod'
  }) {
    const key = env === 'prod' ? ENV.RESEND_API_KEY_PROD : ENV.RESEND_API_KEY_STAGING
    if (!key) return { ok: true, note: '(dry-run) no RESEND key set' }
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ from: 'Butler <notify@example.com>', to, subject, html })
    })
    if (!r.ok) throw new Error(`resend_failed ${r.status}`)
    return await r.json()
  }
}
