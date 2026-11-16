import type { AgentManifest } from '@custodes/schema';
import { CHEATSHEET_REVIEW_MANIFEST } from './agents/cheatsheet-review.js';
import { IMPLEMENTATION_CHECK_MANIFEST } from './agents/implementation-check.js';
import { PR_GATE_MANIFEST } from './agents/pr-gate.js';
import { PROPOSAL_REVIEW_MANIFEST } from './agents/proposal-review.js';
import { TRIAGE_MANIFEST } from './agents/triage.js';

/**
 * Every agent, whichever Worker it runs in (ADR 0018). The gateway's `/admin/agents` reads it from
 * custodes-agents; the `/new-agent` skill appends to it. triage-apply is not listed yet.
 */
export const REGISTRY: readonly AgentManifest[] = [
  TRIAGE_MANIFEST,
  IMPLEMENTATION_CHECK_MANIFEST,
  PROPOSAL_REVIEW_MANIFEST,
  PR_GATE_MANIFEST,
  CHEATSHEET_REVIEW_MANIFEST,
];
