import type { AgentManifest } from '@custodes/schema';
import { HELLO_MANIFEST } from './agents/hello.js';
import { IMPLEMENTATION_CHECK_MANIFEST } from './agents/implementation-check.js';
import { PROPOSAL_REVIEW_MANIFEST } from './agents/proposal-review.js';
import { TRIAGE_MANIFEST } from './agents/triage.js';

/**
 * Every agent class deployed in this Worker. The gateway's `/admin/agents` reads it; the
 * `/new-agent` skill appends to it. Keep in sync with wrangler.jsonc durable_objects bindings.
 */
export const REGISTRY: readonly AgentManifest[] = [
  HELLO_MANIFEST,
  TRIAGE_MANIFEST,
  IMPLEMENTATION_CHECK_MANIFEST,
  PROPOSAL_REVIEW_MANIFEST,
];
