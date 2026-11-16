import type { AccessJwtOptions } from '@custodes/core';

/**
 * How the broker fetches Cloudflare Access keys. Production uses the defaults (fetch, the clock);
 * tests inject `fetchImpl`. Kept out of the Worker's main module, which exports only entrypoints.
 */
export const accessOptions: AccessJwtOptions = {};
