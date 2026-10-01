import type { BrokerGitHubReader } from '../triage/github.js';

/** I/O for one specialist job; injected so the logic is tested without network access. */
export interface SpecialistDeps {
  reader: Pick<
    BrokerGitHubReader,
    | 'getIssue'
    | 'listTimeline'
    | 'listComments'
    | 'listPullFiles'
    | 'listCheatSheets'
    | 'listLabels'
    | 'getCheatSheet'
  >;
  /** Fast model: picks the cheat sheets to read. Returns raw text. */
  select(system: string, user: string, issue: number): Promise<string>;
  /** Reasoning model: the assessment itself. Returns raw text. */
  assess(system: string, user: string, issue: number): Promise<string>;
}

export async function loadCheatSheets(
  repo: string,
  names: string[],
  deps: Pick<SpecialistDeps, 'reader'>,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of names) files.set(name, await deps.reader.getCheatSheet(repo, name));
  return files;
}
