import fs from 'fs'
import path from 'path'

type Rule = {
  tools: Record<string, { allow?: string[], deny?: string[], approvals?: any[] }>
  paths_allow?: string[]
  rate_limits?: Record<string, number>
  time_windows?: Record<string, any>
}
export type Policy = { version: number; repos: Record<string, Rule> }

export function loadPolicy(): Policy {
  // Policy file lives in the target repo as .butler/policy.yaml in a real setup.
  // For first run, embed a safe default:
  return {
    version: 1,
    repos: {
      default: {
        tools: {
          "github": { allow: ["read_file","write_file","open_pr"] },
          "supabase": { allow: ["deploy_function","set_function_env","invoke_rpc","sql_migrate:staging"], deny:["sql_migrate:prod"] },
          "stripe": { allow: ["read_connect_account:test"] },
          "deploy": { allow: ["create_preview"] },
          "email": { allow: ["send_test"] }
        },
        paths_allow: ["^src/","^supabase/","^\\.github/","^package\\.json$","^tsconfig\\.json$"]
      }
    }
  }
}

export function isAllowed(policy: Policy, repo: string, tool: string, action: string, env='staging') {
  const rule = policy.repos[repo] || policy.repos['default']
  const t = rule.tools[tool]
  if (!t) return false
  const key = action + (env && action.includes('sql_migrate') ? `:${env}` : '')
  if (t.deny?.some(a => a === key || a === action)) return false
  if (t.allow?.some(a => a === key || a === action)) return true
  return false
}
