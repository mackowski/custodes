// The rules of block-secrets.mjs, apart from the hook so a test can import them.
import { readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** Paths that hold secrets. Tested against an absolute path with `/` separators. */
const SECRET = [
  /\.dev\.vars/,
  /secret[^/]*\.tfvars$/,
  /\/backend\.hcl$/,
  /\/secrets\//,
  /\.pem$/,
  /\.key$/,
  /\/\.wrangler\//,
  /\/\.cloudflared\//,
];

/**
 * Whether a file, or a directory (given without a trailing slash), holds secrets.
 * @param {string} path
 */
export function isSecretPath(path) {
  const p = path.split(sep).join('/');
  return SECRET.some((re) => re.test(p) || re.test(`${p}/`));
}

/** Directories never walked: huge, and nothing of ours is in them. */
const SKIP = new Set(['node_modules', '.git']);
/** More entries than this under the search root: too broad to check, so refuse. */
export const MAX_ENTRIES = 50_000;

/**
 * Secret-bearing files under `root`, as paths relative to it. Null when the tree is too large.
 * @param {string} root
 * @returns {string[] | null}
 */
export function secretFilesUnder(root) {
  /** @type {string[]} */
  const found = [];
  const todo = [root];
  let seen = 0;
  for (let dir = todo.pop(); dir !== undefined; dir = todo.pop()) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // not a directory, or unreadable: ripgrep cannot read it either
    }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) return null;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) todo.push(full);
      } else if (isSecretPath(full)) found.push(relative(root, full).split(sep).join('/'));
    }
  }
  return found;
}

/**
 * The patterns in a Grep `glob` value: split on spaces, and on commas outside braces.
 * @param {string} glob
 */
export function globPatterns(glob) {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of glob) {
    if (ch === '{') depth++;
    if (ch === '}') depth = Math.max(0, depth - 1);
    if ((ch === ',' && depth === 0) || /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * A ripgrep glob as a regular expression over a `/`-separated path. Written here, not taken from
 * `path.matchesGlob`: that one never lets a wildcard match a leading dot, and ripgrep does (`*`
 * selects `.dev.vars`). Null for a glob this cannot read; the caller then assumes it selects.
 * @param {string} glob
 * @returns {RegExp | null}
 */
export function globRegExp(glob) {
  let re = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? '';
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) return null;
      const body = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
      re += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
      i = end;
    } else if (ch === '{') {
      braces++;
      re += '(?:';
    } else if (ch === '}' && braces > 0) {
      braces--;
      re += ')';
    } else if (ch === ',' && braces > 0) re += '|';
    else if (ch === '\\') {
      i++;
      re += (glob[i] ?? '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    } else re += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  if (braces !== 0) return null;
  try {
    return new RegExp(`^${re}$`);
  } catch {
    return null;
  }
}

/**
 * Whether a ripgrep include glob selects the file. Ripgrep reads globs as .gitignore does: one
 * without a slash matches a name at any depth, one with a slash is read from the search root, and
 * one that matches a directory selects what is under it. Errs towards "selects".
 * @param {string} pattern
 * @param {string} file path relative to the search root, with `/` separators
 */
export function globSelects(pattern, file) {
  if (pattern.startsWith('!')) return false; // an exclusion selects nothing
  const p = pattern.replace(/^\.?\//, '').replace(/\/$/, '');
  const re = globRegExp(p);
  if (re === null) return true;
  const parts = file.split('/');
  for (let n = 1; n <= parts.length; n++)
    if (re.test(p.includes('/') ? parts.slice(0, n).join('/') : (parts[n - 1] ?? ''))) return true;
  return false;
}

/**
 * Why a Read, Edit, Write or Grep call must be refused, or null. A Grep with a glob is checked
 * against the files that are there: a ripgrep glob searches git-ignored files too, so `.d*` reads
 * `.dev.vars` although no part of the call spells that name. Without a glob ripgrep skips
 * git-ignored files, and every secret-bearing path in the repository is git-ignored.
 * @param {unknown} event the PreToolUse hook input
 * @returns {string | null}
 */
export function refusal(event) {
  const e = /** @type {{ tool_name?: unknown, cwd?: unknown, tool_input?: unknown } | null} */ (
    typeof event === 'object' ? event : null
  );
  const input = /** @type {Record<string, unknown>} */ (
    e !== null && typeof e.tool_input === 'object' && e.tool_input !== null ? e.tool_input : {}
  );
  /** @param {string} k */
  const text = (k) => (typeof input[k] === 'string' ? input[k] : '');
  for (const k of ['file_path', 'path'])
    if (text(k) && isSecretPath(resolve(text(k)))) return `secret-bearing file: ${text(k)}`;
  const glob = text('glob');
  if (!glob) return null;
  if (isSecretPath(`/${glob}`)) return `secret-bearing file: ${glob}`;
  const cwd = e !== null && typeof e.cwd === 'string' ? e.cwd : process.cwd();
  const root = resolve(cwd, text('path') || '.');
  const files = secretFilesUnder(root);
  if (files === null)
    return `too many files under ${root} to check a glob against: narrow the path`;
  const patterns = globPatterns(glob);
  const hit = files.find((f) => patterns.some((p) => globSelects(p, f)));
  return hit === undefined ? null : `the glob selects a secret-bearing file: ${hit}`;
}
