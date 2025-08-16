import { ENV } from '../lib/env'

function keyForEnv(env: 'staging'|'prod') {
  return env === 'prod' ? ENV.SUPABASE_SERVICE_ROLE_KEY_PROD : ENV.SUPABASE_SERVICE_ROLE_KEY_STAGING
}

export const supabaseTools = {
  async deploy_function({ name, folder }:{ name:string, folder:string }) {
    // Simplified placeholder: in real code, upload the function bundle via Supabase CLI or REST.
    return { ok: true, note: `Deploy ${name} from ${folder} (wire CLI/REST later)` }
  },
  async set_function_env({ name, env: targetEnv, kv }:{ name:string, env:'staging'|'prod', kv:Record<string,string> }) {
    // Placeholder: set env via Supabase management API/CLI
    const keys = Object.keys(kv)
    return { ok: true, note: `Set ${keys.join(',')} on ${name} (${targetEnv})` }
  },
  async invoke_rpc({ url, anonKey, schema='app', fn, args }:{ url?:string, anonKey?:string, schema?:string, fn:string, args:any }) {
    const base = url || ENV.SUPABASE_URL
    const key = anonKey || ENV.SUPABASE_ANON_KEY
    const res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type':'application/json', Prefer: `return=representation` },
      body: JSON.stringify(args || {})
    })
    if (!res.ok) throw new Error(`rpc_failed ${fn} ${res.status}`)
    return await res.json()
  },
  async sql_migrate({ env, sql }:{ env:'staging'|'prod', sql:string }) {
    // In real usage: use Postgres connection or Supabase SQL API. For now, block prod.
    if (env === 'prod') throw new Error('sql_migrate on prod requires approval (blocked by default)')
    return { ok: true, note: 'Simulated staging migration (wire SQL API/psql later)' }
  }
}
