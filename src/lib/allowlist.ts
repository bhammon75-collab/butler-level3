// Allowlist for regular edits
const ALLOW = [
  /^src\//,
  /^supabase\//,
  // Do NOT allow broad ".github/**". We allow only workflows, and those are gated.
  /^package\.json$/,
  /^tsconfig\.json$/
]

export function isPathAllowed(p: string) {
  // Regular allowlist OR workflow path (handled by a separate gate)
  return ALLOW.some(rx => rx.test(p)) || isWorkflowPath(p)
}

// Detect ".github/workflows/*" edits. These require an extra approval header.
export function isWorkflowPath(p: string) {
  return /^\.github\/workflows\//.test(p)
}
