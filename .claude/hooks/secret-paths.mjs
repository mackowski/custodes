// The rules of block-secrets.mjs, apart from the hook so a test can import them.
import { readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** Paths that hold secrets. Tested against an absolute path with `/` separators. */
const SECRET = [
  /\.dev\.vars/,
  /secret.*\.tfvars$/,
  /\/backend\.hcl$/,
  /\/secrets\//,
  /\.pem$/,
  /\.key$/,
  /\/\.wrangler\//,
  /\/\.cloudflared\//,
  /\/\.env(\.|$)/,
  /\/\.ssh\//,
  /\/\.aws\//,
  /\/\.config\/gh\//,
];

/**
 * Whether a file, or a directory (given without a trailing slash), holds secrets.
 * @param {string} path
 */
export function isSecretPath(path) {
  // Lower case: the patterns are, and the default macOS disk ignores case (`.DEV.VARS`).
  const p = path.split(sep).join('/').toLowerCase();
  return SECRET.some((re) => re.test(p) || re.test(`${p}/`));
}

/**
 * Whether a link points at a secret-bearing file (a link to a folder is not followed).
 * @param {string} link
 */
function linksToSecret(link) {
  try {
    return isSecretPath(realpathSync(link));
  } catch {
    return false; // dangling: nothing to read
  }
}

/** Directories never walked: huge, and nothing of ours is in them. */
const SKIP = new Set(['node_modules', '.git']);
/** More entries than this under the search root: too broad to check, so refuse. */
export const MAX_ENTRIES = 20_000;

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
      } else if (isSecretPath(full) || (e.isSymbolicLink() && linksToSecret(full)))
        found.push(relative(root, full).split(sep).join('/'));
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
 * without a slash matches a name at any depth, and one that matches a directory selects what is
 * under it. One with a slash is matched by ripgrep against the path it walks, which starts at the
 * search path as given, so here it is tried from every directory of the file's full path
 * (`**\/gateway/*` with the search in `workers/gateway` selects `.dev.vars`). Errs towards "selects".
 * @param {string} pattern
 * @param {string} file path relative to the search root, with `/` separators
 * @param {string} [root] the search root, absolute
 */
export function globSelects(pattern, file, root = '') {
  if (pattern.startsWith('!')) return false; // an exclusion selects nothing
  const p = pattern.replace(/^\.?\//, '').replace(/\/$/, '');
  const re = globRegExp(p);
  if (re === null) return true;
  const above = root.split(sep).filter(Boolean);
  const parts = [...above, ...file.split('/')];
  for (let end = above.length + 1; end <= parts.length; end++) {
    if (!p.includes('/')) {
      if (re.test(parts[end - 1] ?? '')) return true;
      continue;
    }
    for (let start = 0; start < end; start++)
      if (re.test(parts.slice(start, end).join('/'))) return true;
  }
  return false;
}

/**
 * Whether .gitignore hides the file from a search without a glob. Exact case and exact forms, as
 * ripgrep reads them: a name the patterns above call secret but .gitignore does not list
 * (`.dev.vars~`, `.Dev.Vars`) is searched, so it is not hidden.
 * @param {string} file path relative to the repository, with `/` separators
 */
export function gitIgnored(file) {
  const name = file.split('/').pop() ?? '';
  return (
    name === '.dev.vars' ||
    name.startsWith('.dev.vars.') ||
    name === '.env' ||
    name.startsWith('.env.') ||
    name === 'backend.hcl' ||
    /\.(pem|key|tfvars)$/.test(name) ||
    /(^|\/)(\.wrangler|\.cloudflared|secrets|node_modules)\//.test(file)
  );
}

/**
 * Why a Read, Edit, Write or Grep call must be refused, or null. A Grep with a glob is checked
 * against the files that are there: a ripgrep glob searches git-ignored files too, so `.d*` reads
 * `.dev.vars` although no part of the call spells that name. Without a glob ripgrep skips
 * git-ignored files, and every secret-bearing path in the repository is git-ignored.
 * @param {unknown} event the PreToolUse hook input
 * @param {string} [project] the repository root; the session's project directory when left out
 * @returns {string | null}
 */
export function refusal(
  event,
  project = resolve(process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd()),
) {
  const e = /** @type {{ tool_name?: unknown, cwd?: unknown, tool_input?: unknown } | null} */ (
    typeof event === 'object' ? event : null
  );
  const input = /** @type {Record<string, unknown>} */ (
    e !== null && typeof e.tool_input === 'object' && e.tool_input !== null ? e.tool_input : {}
  );
  /** @param {string} k */
  const text = (k) => (typeof input[k] === 'string' ? input[k] : '');
  const cwd = e !== null && typeof e.cwd === 'string' ? e.cwd : process.cwd();
  for (const k of ['file_path', 'path']) {
    if (!text(k)) continue;
    const given = resolve(cwd, text(k));
    let real = given;
    try {
      real = realpathSync(given); // a link to a secret-bearing file is that file
    } catch {
      // not there yet (a Write): the path as given is all there is
    }
    if (isSecretPath(given) || isSecretPath(real)) return `secret-bearing file: ${text(k)}`;
  }
  if (e?.tool_name !== 'Grep') return null;
  const glob = text('glob');
  if (glob && isSecretPath(`/${glob}`)) return `secret-bearing file: ${glob}`;
  const root = resolve(cwd, text('path') || '.');
  // Without a glob ripgrep skips git-ignored files, and in this repository every secret-bearing
  // path is git-ignored. Outside it nothing hides them (`~/.wrangler`, `~/.cloudflared`).
  const inProject = root === project || root.startsWith(`${project}${sep}`);
  const files = secretFilesUnder(root);
  if (files === null) return `too many files under ${root} to check: narrow the path`;
  if (!glob) {
    // Inside the repository only what .gitignore does not hide is searched: a link (its own name
    // is not ignored) or a secret-bearing name in a form .gitignore does not list.
    const fromRepo = relative(project, root).split(sep).join('/');
    const reached = inProject
      ? files.find((f) => !gitIgnored(fromRepo ? `${fromRepo}/${f}` : f))
      : files[0];
    return reached === undefined ? null : `the search reaches a secret-bearing file: ${reached}`;
  }
  const patterns = globPatterns(glob);
  const hit = files.find((f) => patterns.some((p) => globSelects(p, f, root)));
  return hit === undefined ? null : `the glob selects a secret-bearing file: ${hit}`;
}
