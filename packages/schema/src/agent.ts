import { z } from 'zod';

/** Lower-case, dash-separated, stable identifier of an agent (e.g. `triage`). */
export const AgentId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,30}$/, 'agent id: lowercase letters, digits, dashes; 2–31 chars');
export type AgentId = z.infer<typeof AgentId>;

export const SemVer = z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'semver');

/**
 * hitl = human in the loop: every side effect waits for an approval.
 * hotl = human on the loop: acts within policy, logs, notifies; can be halted.
 */
export const AgentMode = z.enum(['hitl', 'hotl']);
export type AgentMode = z.infer<typeof AgentMode>;

export const GitHubRepo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/repo');
export type GitHubRepo = z.infer<typeof GitHubRepo>;

export const AgentManifest = z.object({
  id: AgentId,
  version: SemVer,
  description: z.string().min(1).max(280),
  mode: AgentMode,
  repos: z.array(GitHubRepo).min(1),
});
export type AgentManifest = z.infer<typeof AgentManifest>;

export const KillSwitchState = z.object({
  halted: z.boolean(),
  reason: z.string().optional(),
  by: z.string().optional(),
  at: z.iso.datetime().optional(),
});
export type KillSwitchState = z.infer<typeof KillSwitchState>;
