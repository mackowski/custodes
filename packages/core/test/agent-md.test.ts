import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as schema from '@custodes/schema';
import {
  checkAgentDefinitions,
  parseAgentMd,
  Policy,
  type AgentDefinition,
} from '@custodes/schema';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const live = Policy.parse(
  JSON.parse(readFileSync(join(ROOT, 'workers/github-broker/policy/policy.json'), 'utf8')),
);

/** Every agent.md in the repository, outside dependencies and build output. */
function agentFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '.wrangler', 'coverage'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) agentFiles(p, out);
    else if (e.name === 'agent.md') out.push(p);
  }
  return out;
}

const md = (front: object, prompt = 'You review issues.') =>
  `---\n${JSON.stringify(front, null, 2)}\n---\n\n${prompt}\n`;

const orchestrator: AgentDefinition = {
  id: 'backlog-review',
  tier: 'T0',
  triggers: ['schedule'],
  model: 'claude-sonnet-5-5',
  tools: ['issues', 'delegate'],
  agents: ['issue-reviewer'],
  context: [],
  outputSchema: 'Proposal',
  budget: { roundsPerRun: 40, usdPerRun: 0.5, usdPerDay: 3 },
};
const child: AgentDefinition = {
  ...orchestrator,
  id: 'issue-reviewer',
  triggers: ['delegate'],
  tools: ['issue', 'comments'],
  agents: [],
  budget: { roundsPerRun: 20, usdPerRun: 0.15, usdPerDay: 3 },
};
const policy = {
  ...live,
  reads: {
    ...live.reads,
    'backlog-review': {
      tokenBinding: 'PAT_READONLY',
      repos: ['OWASP/CheatSheetSeries'],
      resources: ['issues', 'issue', 'comments'],
    },
  },
} as Policy;
const check = (defs: AgentDefinition[], p: Policy = policy) =>
  checkAgentDefinitions(defs, p, schema);

describe('parseAgentMd (ADR 0023)', () => {
  it('reads JSON frontmatter and the prompt', () => {
    const { definition, prompt } = parseAgentMd(md(orchestrator));
    expect(definition).toEqual(orchestrator);
    expect(prompt).toBe('You review issues.');
  });
  it.each([
    ['no frontmatter', 'You review issues.'],
    ['unclosed frontmatter', `---\n${JSON.stringify(orchestrator)}\n`],
    ['YAML that is not JSON', '---\nid: x\n---\nprompt'],
    ['no prompt', md(orchestrator, '')],
    ['an unknown key', md({ ...orchestrator, mode: 'hotl' })],
  ])('refuses %s', (_n, text) => {
    expect(() => parseAgentMd(text)).toThrow();
  });
});

describe('checkAgentDefinitions (ADR 0023)', () => {
  it('accepts an orchestrator and its role', () => {
    expect(check([orchestrator, child])).toEqual([]);
  });
  it('checks the tier against the policy (no write policy means T0)', () => {
    expect(check([{ ...orchestrator, tier: 'T1' }, child])).toContain(
      'backlog-review: tier T1, policy gives T0',
    );
  });
  it('allows only tools in the identity read policy, and delegate only with agents:', () => {
    expect(check([orchestrator, { ...child, tools: ['pull_files'] }])).toContain(
      "issue-reviewer: tool pull_files is not in backlog-review's read policy",
    );
    expect(check([{ ...child, id: 'solo', tools: ['delegate'] }])).toEqual(
      expect.arrayContaining(["solo: tool delegate is not in solo's read policy"]),
    );
  });
  it('needs every role to exist, keeps depth 1, and refuses a role with its own policy', () => {
    expect(check([orchestrator])).toContain('backlog-review: role issue-reviewer has no agent.md');
    expect(check([orchestrator, { ...child, agents: ['issue-reviewer'] }])).toEqual(
      expect.arrayContaining(['issue-reviewer: a role cannot list agents (depth 1)']),
    );
    const withOwn = {
      ...policy,
      reads: { ...policy.reads, 'issue-reviewer': policy.reads['backlog-review']! },
    } as Policy;
    expect(check([orchestrator, child], withOwn)).toContain(
      'issue-reviewer: a role has no policy entry of its own',
    );
  });
  it('needs outputSchema to name a zod schema of @custodes/schema', () => {
    expect(check([{ ...orchestrator, outputSchema: 'NotThere' }, child])).toContain(
      'backlog-review: outputSchema NotThere is not a zod schema of @custodes/schema',
    );
    expect(check([{ ...orchestrator, outputSchema: 'ACTION_REGISTRY' }, child])).toContain(
      'backlog-review: outputSchema ACTION_REGISTRY is not a zod schema of @custodes/schema',
    );
  });
  it('enforces the budget ceilings', () => {
    const errs = check([
      { ...orchestrator, budget: { roundsPerRun: 41, usdPerRun: 1, usdPerDay: 3.5 } },
      { ...child, budget: { roundsPerRun: 21, usdPerRun: 0.2, usdPerDay: 3 } },
    ]);
    expect(errs).toEqual(
      expect.arrayContaining([
        'backlog-review: roundsPerRun 41 > 40',
        'backlog-review: usdPerDay 3.5 > 3',
        'issue-reviewer: roundsPerRun 21 > 20',
        'issue-reviewer: usdPerRun 0.2 > 0.15',
      ]),
    );
  });
});

describe('every agent.md in the repository', () => {
  it('parses and passes the checks against the live policy', () => {
    const files = agentFiles(ROOT);
    const defs = files.map((f) => {
      try {
        return parseAgentMd(readFileSync(f, 'utf8')).definition;
      } catch (err) {
        throw new Error(`${relative(ROOT, f)}: ${(err as Error).message}`, { cause: err });
      }
    });
    expect(checkAgentDefinitions(defs, live, schema as Record<string, unknown>)).toEqual([]);
  });
});
