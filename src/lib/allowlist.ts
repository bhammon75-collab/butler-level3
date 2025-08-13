const ALLOW = [
  /^src\//,
  /^supabase\//,
  /^\.github\//,
  /^package\.json$/,
  /^tsconfig\.json$/
]
export function isPathAllowed(p: string) {
  return ALLOW.some(rx => rx.test(p))
}
