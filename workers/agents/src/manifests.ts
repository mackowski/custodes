import type { AgentManifest } from '@custodes/schema';
import { INSTANCE_REPOS } from './instances.js';

/**
 * Every agent's manifest, as plain data with no agent code (#105): the registry Worker
 * (custodes-agents) imports only this file, so it bundles neither the Agents SDK nor any agent.
 * Each agent module re-exports its own manifest.
 */
export const TRIAGE_MANIFEST: AgentManifest = {
  id: 'triage',
  version: '0.2.0',
  description:
    'Read-only triage report for OWASP Cheat Sheet Series issues: suggests labels, cheat sheet and duplicates, delegates to implementation-check and proposal-review, e-mails daily.',
  mode: 'readonly',
  repos: [...INSTANCE_REPOS],
};

export const IMPLEMENTATION_CHECK_MANIFEST: AgentManifest = {
  id: 'implementation-check',
  version: '0.1.0',
  description:
    'Read-only: for issues accepted (ACK_OBTAINED) over a week ago, checks whether the cheat sheets already implement them and quotes the evidence. Called by triage.',
  mode: 'readonly',
  repos: [...INSTANCE_REPOS],
};

export const PROPOSAL_REVIEW_MANIFEST: AgentManifest = {
  id: 'proposal-review',
  version: '0.1.0',
  description:
    'Read-only: for community issues not yet accepted, checks whether the proposal is sound, already covered or a real gap, and recommends labels, assignee and a comment. Called by triage.',
  mode: 'readonly',
  repos: [...INSTANCE_REPOS],
};

export const PR_GATE_MANIFEST: AgentManifest = {
  id: 'pr-gate',
  version: '0.1.0',
  description:
    'Checks open community PRs against CONTRIBUTING.md (approved and assigned issue, minor fix, AI disclosure) and closes those that break it with a signed comment. Daily e-mail summary.',
  mode: 'hotl',
  repos: [...INSTANCE_REPOS],
};

export const CHEATSHEET_REVIEW_MANIFEST: AgentManifest = {
  id: 'cheatsheet-review',
  version: '0.2.0',
  description:
    'Multi-model review of a cheat sheet pull request when the operator adds the trigger label: posts one review with inline suggestions, e-mails a close recommendation for low-quality PRs.',
  mode: 'hotl',
  // OWASP reviews are posted only after the operator approves each one (policy requiresApprovalOn).
  repos: ['mackowski/custodes-sandbox', 'OWASP/CheatSheetSeries'],
};

export const TRIAGE_APPLY_MANIFEST: AgentManifest = {
  id: 'triage-apply',
  version: '0.1.0',
  description:
    'Turns one triage proposal (assignee, labels, comment) into one approval request; the broker applies it only after the operator approves the e-mailed link (ADR 0019). No model.',
  mode: 'hitl',
  repos: ['mackowski/custodes-sandbox', 'OWASP/CheatSheetSeries'],
};
