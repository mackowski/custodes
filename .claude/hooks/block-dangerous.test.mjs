import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('./block-dangerous.sh', import.meta.url));
const run = (command) =>
  spawnSync('bash', [hook], { input: JSON.stringify({ tool_input: { command } }) }).status;

test('denies git commands that write files or run commands', () => {
  for (const command of [
    'git log -1 --format=x --output=.claude/hooks/block-dangerous.sh',
    'git log -1 --format=x --"output"=x.sh',
    "git log -1 --'output'=x.sh",
    "git log -1 --$'\\157utput'=x.sh",
    'git log -1 \\\n--output=x.sh',
    'cd x && git show HEAD --output=y',
    "git difftool -y --extcmd='sh -c id'",
  ]) {
    assert.equal(run(command), 2, command);
  }
});

test('allows the git commands a review needs', () => {
  for (const command of [
    'git diff origin/main...HEAD -- a.ts',
    "git log --oneline --format='%h %s' -5",
    'git diff -U99999 origin/main...feat/x -- src/a.ts',
    'gh pr diff 147',
  ]) {
    assert.equal(run(command), 0, command);
  }
});
