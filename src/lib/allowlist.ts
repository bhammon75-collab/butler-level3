// src/lib/allowlist.ts

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

/** tiny glob -> RegExp: ** => .*, * => [^/]*, escape regex meta */
function globToRegExp(glob: string): RegExp {
  const g = norm(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DS::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DS::/g, '.*');
  return new RegExp('^' + g + '$');
}

/** Paths Butler may write/replace */
export const SAFE_WRITE_GLOBS: string[] = [
  // App code
  'src/**',

  // Supabase (SQL, functions, config)
  'supabase/**',

  // Project docs at repo root
  'docs/**',
  'README.md',
  'README*.md',
    '*.md',

  // Common root config
  'config/**',        // <-- added
  'package.json',
  'tsconfig.json',

  // Workflows (require extra approval header)
  '.github/workflows/**',
];

export function isWorkflowPath(p: string): boolean {
  const n = norm(p);
  return n.startsWith('.github/workflows/');
}

export function isPathAllowed(p: string): boolean {
  const n = norm(p);
  return SAFE_WRITE_GLOBS.some((g) => globToRegExp(g).test(n));
}
