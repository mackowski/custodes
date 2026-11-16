import { z } from 'zod';
import { escapeHtml, layout } from './approval-page.js';

/** One row of the broker's `/v1/agents/states`: the agent's own flag, or the fleet's for `*`. */
export const AgentFlag = z.object({
  id: z.string().max(64),
  halted: z.boolean(),
  reason: z.string().max(500).optional(),
  by: z.string().max(200).optional(),
  at: z.string().max(40).optional(),
});
export type AgentFlag = z.infer<typeof AgentFlag>;

/**
 * The kill switch in a browser (no CLI on a phone): each agent's state, a Halt form for every
 * operator and a Resume button that only approvers can use (the broker checks again, #104).
 * Everything shown is escaped; the forms post to this origin only (PAGE_HEADERS CSP).
 */
export function killSwitchPage(flags: readonly AgentFlag[], approver: boolean): string {
  const row = (f: AgentFlag) => {
    const id = encodeURIComponent(f.id);
    const name = f.id === '*' ? 'Whole fleet (*)' : f.id;
    const state = f.halted
      ? `<strong>halted</strong>${f.reason ? `: ${escapeHtml(f.reason)}` : ''}${f.by ? ` (by ${escapeHtml(f.by)}` : ''}${f.at ? `${f.by ? ', ' : ' ('}${escapeHtml(f.at)})` : f.by ? ')' : ''}`
      : 'running';
    const halt = `<form method="post" action="/admin/kill-switch/${id}/halt"><input name="reason" required minlength="3" maxlength="500" placeholder="reason"> <button>Halt</button></form>`;
    const resume = f.halted
      ? approver
        ? `<form method="post" action="/admin/kill-switch/${id}/resume"><button>Resume</button></form>`
        : '<p class="note">Only an approver may resume.</p>'
      : '';
    return `<h2>${escapeHtml(name)}</h2><p>${state}</p>${halt}${resume}`;
  };
  return layout(
    'Kill switch',
    `<h1>Kill switch</h1><p class="note">Halting stops new side effects at once: the broker checks the flag on every call. Any operator may halt; only an approver may resume.</p>${flags.map(row).join('')}`,
  );
}
