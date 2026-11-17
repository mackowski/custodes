import { describe, expect, it } from 'vitest';
import { Status } from '../src/commands/agents.js';

describe('agents status', () => {
  it("keeps the fields each agent adds to its status (pr-gate's enforcing, queues, recent rows)", () => {
    const parsed = Status.parse({
      manifest: {
        id: 'pr-gate',
        version: '0.1.0',
        description: 'd',
        mode: 'hotl',
        repos: ['mackowski/custodes-sandbox'],
      },
      state: { closesToday: 1 },
      killSwitch: { halted: false },
      enforcing: true,
      recent: [{ pr: 1 }],
    });
    expect(parsed).toMatchObject({ enforcing: true, recent: [{ pr: 1 }] });
  });
});
