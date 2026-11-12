import type { AgentManifest } from '@custodes/schema';
import { CHEATSHEET_REVIEW_MANIFEST } from './agents/cheatsheet-review.js';
import { IMPLEMENTATION_CHECK_MANIFEST } from './agents/implementation-check.js';
import { PR_GATE_MANIFEST } from './agents/pr-gate.js';
import { PROPOSAL_REVIEW_MANIFEST } from './agents/proposal-review.js';
import { TRIAGE_MANIFEST } from './agents/triage.js';

/**
 * Every agent class deployed in this Worker. The gateway's `/admin/agents` reads it; the
 * `/new-agent` skill appends to it. Keep in sync with wrangler.jsonc durable_objects bindings.
 */
export const REGISTRY: readonly AgentManifest[] = [
  TRIAGE_MANIFEST,
  IMPLEMENTATION_CHECK_MANIFEST,
  PROPOSAL_REVIEW_MANIFEST,
  PR_GATE_MANIFEST,
  CHEATSHEET_REVIEW_MANIFEST,
];
