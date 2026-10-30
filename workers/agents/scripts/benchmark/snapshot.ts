/** The agent's `Snapshot` rebuilt from a frozen pull request. No side effects. */
import { parsePatch } from '../../src/agents/cheatsheet-review/diff.js';
import type { Snapshot } from '../../src/agents/cheatsheet-review/input.js';
import { fencedLines } from '../../src/agents/cheatsheet-review/scope.js';
import type { FrozenPull } from './select.js';

export function snapshotOf(f: FrozenPull): Snapshot {
  const contents = new Map(f.contents);
  return {
    repo: 'OWASP/CheatSheetSeries',
    pull: f.pull,
    headSha: f.sha,
    author: f.author,
    title: f.title,
    body: f.body,
    files: f.files.map((file) => ({
      file,
      hunks: parsePatch(file.patch),
      codeLines: fencedLines(contents.get(file.filename) ?? ''),
    })),
    contents,
    disclosure: f.disclosure,
    issues: [],
    sheetNames: f.sheetNames,
    related: new Map(f.related),
    unreviewedFiles: 0,
  };
}
