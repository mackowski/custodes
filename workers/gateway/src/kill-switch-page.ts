import { z } from 'zod';
import { escapeHtml, layout } from './approval-page.js';

/**
 * One row of the broker's `/v1/agents/states`: the agent's own flag, or the fleet's for `*`. No
 * length caps beyond the id: one odd stored flag must not take the page down during an incident
 * (review of #130).
 */
export const AgentFlag = z.object({
  id: z.string().max(64),
  halted: z.boolean(),
  reason: z.string().optional(),
  by: z.string().optional(),
  at: z.string().optional(),
});
export type AgentFlag = z.infer<typeof AgentFlag>;

/**
 * The kill switch in a browser (no CLI on a phone): each agent's state, a Halt form for every
 * operator and a Resume button that only approvers can use (the broker checks again, #104).
 * Everything shown is escaped; the forms post to this origin only (PAGE_HEADERS CSP).
 * `flags === null` means the state could not be read: the page still offers Halt (and Resume to
 * approvers) for the whole fleet, since halting needs no read.
 */
export function killSwitchPage(flags: readonly AgentFlag[] | null, approver: boolean): string {
  const unknown = flags === null;
  const row = (f: AgentFlag) => {
    const id = encodeURIComponent(f.id);
    const name = f.id === '*' ? 'Whole fleet (*)' : f.id;
    const state = unknown
      ? '<strong>state unknown</strong> (the broker did not answer)'
      : f.halted
        ? `<strong>halted</strong>${f.reason ? `: ${escapeHtml(f.reason)}` : ''}${f.by ? ` (by ${escapeHtml(f.by)}` : ''}${f.at ? `${f.by ? ', ' : ' ('}${escapeHtml(f.at)})` : f.by ? ')' : ''}`
        : 'running';
    const halt = `<form method="post" action="/admin/kill-switch/${id}/halt"><input name="reason" required minlength="3" maxlength="500" placeholder="reason"> <button>Halt</button></form>`;
    const resume =
      f.halted || unknown
        ? approver
          ? `<form method="post" action="/admin/kill-switch/${id}/resume"><button>Resume</button></form>`
          : '<p class="note">Only an approver may resume.</p>'
        : '';
    return `<h2>${escapeHtml(name)}</h2><p>${state}</p>${halt}${resume}`;
  };
  return layout(
    'Kill switch',
    `<h1>Kill switch</h1><p class="note">Halting stops new side effects at once: the broker checks the flag on every call. Any operator may halt; only an approver may resume.</p>${(flags ?? [{ id: '*', halted: false }]).map(row).join('')}`,
  );
}
