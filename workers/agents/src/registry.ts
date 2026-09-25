import type { AgentManifest } from '@custodes/schema';
import { HELLO_MANIFEST } from './agents/hello.js';

/**
 * Every agent class deployed in this Worker. The gateway's `/admin/agents` reads it; the
 * `/new-agent` skill appends to it. Keep in sync with wrangler.jsonc durable_objects bindings.
 */
export const REGISTRY: readonly AgentManifest[] = [HELLO_MANIFEST];
