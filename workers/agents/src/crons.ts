/** Must match `triggers.crons` in workers/agents/wrangler.jsonc and workers/pr-gate/wrangler.jsonc. */
export const CRON_TRIAGE_POLL = '17 */4 * * *';
/** Daily, before the digest: fresh poll plus specialist reviews of everything the digest will show. */
export const CRON_TRIAGE_PREPARE = '30 5 * * *';
export const CRON_TRIAGE_DIGEST = '0 7 * * *';
