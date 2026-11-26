/** Must match `triggers.crons` in workers/triage/wrangler.jsonc and workers/pr-gate/wrangler.jsonc. */
export const CRON_TRIAGE_POLL = '17 */4 * * *';
/** Daily, before the digest: fresh poll plus specialist reviews of everything the digest will show. */
export const CRON_TRIAGE_PREPARE = '30 5 * * *';
export const CRON_TRIAGE_DIGEST = '0 7 * * *';
/** backlog-review (#132 v1): hourly, code-only check; a model runs only when an issue is due. */
export const CRON_BACKLOG_REVIEW = '41 * * * *';
