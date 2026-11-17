import { describe, expect, it } from 'vitest';
import { isLive, mustRefuse } from '../../../scripts/do-namespace-rules.js';

/**
 * The deploy guard (deploy-workers.yml): a Worker must not redeclare a Durable Object class whose
 * namespace another Worker owns, or an empty copy of the agent would start next to its moved data.
 */
describe('deploy guard for Durable Object classes', () => {
  it('counts an export without a state and a binding without script_name as live', () => {
    expect(isLive({ exports: { PrGateAgent: {} } }, 'PrGateAgent')).toBe(true);
    expect(
      isLive({ durable_objects: { bindings: [{ class_name: 'PrGateAgent' }] } }, 'PrGateAgent'),
    ).toBe(true);
  });

  it('does not count a tombstone, a binding to another Worker, or another class', () => {
    expect(isLive({ exports: { PrGateAgent: { state: 'transferred' } } }, 'PrGateAgent')).toBe(
      false,
    );
    expect(
      isLive(
        {
          durable_objects: {
            bindings: [{ class_name: 'PrGateAgent', script_name: 'custodes-pr-gate' }],
          },
        },
        'PrGateAgent',
      ),
    ).toBe(false);
    expect(isLive({ exports: { TriageAgent: {} } }, 'PrGateAgent')).toBe(false);
    expect(isLive({ exports: {} }, 'PrGateAgent')).toBe(false);
  });

  it('refuses a live class owned by another Worker or by nobody, and nothing else', () => {
    expect(mustRefuse(true, 'custodes-pr-gate', 'custodes-agents')).toBe(true);
    // A lookup that found no owner must not pass.
    expect(mustRefuse(true, '', 'custodes-agents')).toBe(true);
    expect(mustRefuse(true, 'custodes-pr-gate', 'custodes-pr-gate')).toBe(false);
    expect(mustRefuse(false, 'custodes-pr-gate', 'custodes-agents')).toBe(false);
  });
});
