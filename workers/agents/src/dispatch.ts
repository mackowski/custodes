import type { InboundEvent } from '@custodes/schema';
import { INSTANCES } from './instances.js';

/** Pull request actions that wake pr-gate. Edits and pushes are caught by its own re-polls. */
const PR_GATE_ACTIONS: readonly string[] = ['opened', 'reopened'];

export type Route =
  | { agent: 'pr-gate'; instance: string; pr: number; updatedAt: string }
  | { agent: 'cheatsheet-review'; instance: string; pr: number }
  | { agent: null; why: 'unknown_repo' | 'unhandled_event' };

/**
 * Which agent instance a verified webhook event wakes. The payload is only a hint: the repository
 * must be one an instance already works on, and the agent re-reads everything through the broker.
 */
export function route(e: InboundEvent): Route {
  const repo = e.repo.toLowerCase();
  const instance = Object.keys(INSTANCES).find((n) => INSTANCES[n]?.repo.toLowerCase() === repo);
  if (instance === undefined) return { agent: null, why: 'unknown_repo' };
  const pr = e.payload.pull_request;
  if (
    e.event === 'pull_request' &&
    pr !== undefined &&
    PR_GATE_ACTIONS.includes(e.payload.action ?? '')
  )
    return { agent: 'pr-gate', instance, pr: pr.number, updatedAt: pr.updated_at ?? '' };
  // The operator's review label (ADR 0017). The sender is HMAC-signed but still only a hint: the
  // agent re-checks who added the label in the pull request's timeline before doing anything.
  const trigger = INSTANCES[instance]?.reviewTrigger;
  if (
    trigger !== undefined &&
    e.event === 'pull_request' &&
    pr !== undefined &&
    e.payload.action === 'labeled' &&
    e.payload.label?.name === trigger.label &&
    e.payload.sender.login.toLowerCase() === trigger.actor.toLowerCase()
  )
    return { agent: 'cheatsheet-review', instance, pr: pr.number };
  return { agent: null, why: 'unhandled_event' };
}
