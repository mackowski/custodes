// node --test: runs in `pnpm test:hooks` (part of `pnpm test`), so in `pnpm check` and CI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { globPatterns, globSelects, isSecretPath, refusal } from './secret-paths.mjs';

const hook = fileURLToPath(new URL('./block-secrets.mjs', import.meta.url));

/** A repository-like tree with one Worker that has a `.dev.vars` and local state. */
const tree = () => {
  const root = mkdtempSync(join(tmpdir(), 'secrets-hook-'));
  mkdirSync(join(root, 'workers/gateway/.wrangler/state'), { recursive: true });
  mkdirSync(join(root, 'workers/gateway/src'), { recursive: true });
  writeFileSync(join(root, 'workers/gateway/.dev.vars'), 'X=1\n');
  writeFileSync(join(root, 'workers/gateway/.wrangler/state/db.sqlite'), '');
  writeFileSync(join(root, 'workers/gateway/src/index.ts'), '');
  return root;
};

/**
 * @param {string} cwd
 * @param {Record<string, string>} tool_input
 */
const grep = (cwd, tool_input) => refusal({ tool_name: 'Grep', cwd, tool_input }, cwd);

void test('knows secret-bearing files and directories', () => {
  for (const p of [
    '/r/w/.dev.vars',
    '/r/w/.dev.vars.prod',
    '/r/x.pem',
    '/r/.wrangler',
    '/r/secrets/a',
  ])
    assert.equal(isSecretPath(p), true, p);
  for (const p of ['/r/src/index.ts', '/r/prod.tfvars.example', '/r/docs/keys.md'])
    assert.equal(isSecretPath(p), false, p);
});

void test('refuses a path or a glob that names a secret-bearing file', () => {
  assert.match(refusal({ tool_input: { file_path: '/r/w/.dev.vars' } }) ?? '', /secret-bearing/);
  assert.match(refusal({ tool_input: { path: '/r/w/.wrangler' } }) ?? '', /secret-bearing/);
  assert.match(grep(tree(), { pattern: 'x', glob: '**/.dev.vars' }) ?? '', /secret-bearing/);
});

void test('refuses another spelling of the name and a link to the file', () => {
  const root = tree();
  assert.match(
    refusal({ tool_input: { file_path: join(root, 'workers/gateway/.DEV.VARS') } }) ?? '',
    /secret-bearing/,
  );
  symlinkSync(join(root, 'workers/gateway/.dev.vars'), join(root, 'notes.txt'));
  assert.match(
    refusal({ tool_input: { file_path: join(root, 'notes.txt') } }) ?? '',
    /secret-bearing/,
  );
  assert.match(grep(root, { pattern: 'x', path: 'notes.txt' }) ?? '', /secret-bearing/);
});

void test('refuses a Grep glob that selects a secret-bearing file without naming it', () => {
  const root = tree();
  for (const glob of ['.d*', '**/.dev.v*', '.{dev,x}.vars', '*.sqlite', 'workers/**', '*.ts, .d*'])
    assert.match(grep(root, { pattern: 'x', glob }) ?? '', /selects a secret-bearing file/, glob);
  // A wildcard matches a leading dot in ripgrep, so none of these needs to spell one.
  for (const glob of [
    '*',
    '*.vars',
    '*vars*',
    '?dev.vars',
    '[.]dev*',
    '.d*',
    '{*.ts,*.vars}',
    'a[b',
  ])
    assert.match(
      grep(root, { pattern: 'x', glob, path: 'workers/gateway' }) ?? '',
      /selects a secret-bearing file/,
      glob,
    );
  assert.match(
    grep(root, { pattern: 'x', glob: 'workers/gateway/*.vars' }) ?? '',
    /selects a secret-bearing file/,
  );
});

void test('allows a Grep that cannot reach one', () => {
  const root = tree();
  assert.equal(grep(root, { pattern: 'x' }), null);
  assert.equal(grep(root, { pattern: 'x', glob: '*.ts' }), null);
  assert.equal(grep(root, { pattern: 'x', glob: '*.{ts,md}' }), null);
  assert.equal(grep(root, { pattern: 'x', glob: '!.d*' }), null);
  assert.equal(grep(root, { pattern: 'x', glob: 'workers/*/src/**' }), null);
  assert.equal(grep(root, { pattern: 'x', glob: '[a-z]*.ts' }), null);
  assert.equal(grep(root, { pattern: 'x', glob: '.d*', path: 'workers/gateway/src' }), null);
});

void test('outside the repository a Grep without a glob is checked too', () => {
  const home = tree(); // nothing here is git-ignored for a search that starts outside the project
  const project = join(home, 'workers/gateway/src');
  const outside = refusal(
    { tool_name: 'Grep', cwd: home, tool_input: { pattern: 'token' } },
    project,
  );
  assert.match(outside ?? '', /outside the repository reaches a secret-bearing file/);
  const inside = refusal(
    { tool_name: 'Grep', cwd: project, tool_input: { pattern: 'x' } },
    project,
  );
  assert.equal(inside, null);
});

void test('splits several globs but not the alternatives inside braces', () => {
  assert.deepEqual(globPatterns('*.{ts,md}, *.js  .d*'), ['*.{ts,md}', '*.js', '.d*']);
  // A glob with a slash is read from the search root, as ripgrep does.
  assert.equal(globSelects('workers/gateway/src/*.ts', 'workers/gateway/src/index.ts'), true);
  assert.equal(globSelects('src/*.ts', 'workers/gateway/src/index.ts'), false);
  assert.equal(globSelects('*.md', 'workers/gateway/src/index.ts'), false);
});

void test('the hook refuses with exit code 2 and allows with 0 (end to end)', () => {
  /** @param {string} input */
  const run = (input) => spawnSync(process.execPath, [hook], { input, encoding: 'utf8' });
  const denied = run(
    JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/r/.dev.vars' } }),
  );
  assert.equal(denied.status, 2);
  assert.match(denied.stdout, /"permissionDecision":"deny"/);
  const allowed = run(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/r/a.ts' } }));
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, '');
  // Input the hook cannot read is refused, never waved through.
  assert.equal(run('not json').status, 2);
});
