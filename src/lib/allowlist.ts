// src/lib/allowlist.ts
//
// Central write/replace allowlist for Butler.
//  - Paths matching these globs are allowed.
//  - Workflow edits (".github/workflows/**") are additionally gated by the
//    X-Butler-Approve-Workflows header, which the server checks separately.

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

/**
 * Convert a very small subset of glob syntax to a RegExp:
 *  - "**" => ".*"
 *  - "*"  => "[^/]*"
 *  - Escapes regex metacharacters in other text.
 */
function globToRegExp(glob: string): RegExp {
  const g = norm(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex meta
    .replace(/\*\*/g, '::DOUBLE_STAR::')  // temp token
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp('^' + g + '$');
}

/** Allowed write/replace locations */
export const SAFE_WRITE_GLOBS: string[] = [
  // App code
  'src/**',

  // Supabase (SQL, functions, config)
  'supabase/**',

  // Docs at repo root (you asked to allow docs/)
  'docs/**',
  'README.md',
  'README*.md',

  // Common root config
  'package.json',
  'tsconfig.json',

  // Workflows (still require approval header; see server check)
  '.github/workflows/**',
];

/** True if path is under .github/workflows/ (extra header required) */
export function isWorkflowPath(p: string): boolean {
  const n = norm(p);
  return n.startsWith('.github/workflows/');
}

/** True if the given path is allowed by the allowlist */
export function isPathAllowed(p: string): boolean {
  const n = norm(p);
  return SAFE_WRITE_GLOBS.some((g) => globToRegExp(g).test(n));
}
