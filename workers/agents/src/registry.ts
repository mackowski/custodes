import type { AgentManifest } from '@custodes/schema';
import {
  BACKLOG_REVIEW_MANIFEST,
  CHEATSHEET_REVIEW_MANIFEST,
  IMPLEMENTATION_CHECK_MANIFEST,
  PR_GATE_MANIFEST,
  PROPOSAL_REVIEW_MANIFEST,
  TRIAGE_MANIFEST,
} from './manifests.js';

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
  BACKLOG_REVIEW_MANIFEST,
];
