// The public close comment. Built only from code-owned text, validated numbers and logins that
// match GitHub's login syntax; no PR or model text ever reaches it. The broker appends the signed
// trailer (agent, version, attestation id, verify link).
import type { CloseRule } from './rules.js';

const GUIDE = 'https://github.com/OWASP/CheatSheetSeries/blob/master/CONTRIBUTING.md';
const NEW_ISSUE = 'https://github.com/OWASP/CheatSheetSeries/issues/new/choose';

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Logins as inline code, so they never become @-mentions; anything else is dropped. */
function logins(names: readonly string[]): string {
  const ok = names.filter((n) => LOGIN.test(n)).slice(0, 5);
  return ok.length ? ok.map((n) => `\`${n}\``).join(', ') : 'someone else';
}

const issueRefs = (ns: readonly number[]) =>
  ns
    .filter((n) => Number.isSafeInteger(n) && n > 0)
    .slice(0, 5)
    .map((n) => `#${n}`)
    .join(', ');

export interface CloseCommentInput {
  rule: CloseRule;
  issues: readonly number[];
  assignees?: readonly string[];
  now: Date;
}

export function closeComment(input: CloseCommentInput): string {
  const { rule, issues } = input;
  const reason: Record<CloseRule, string[]> = {
    ai_disclosure: [
      'The **AI Tool Usage Disclosure** section of the pull request template is missing or has no option ticked.',
      'The template says: _"Please select exactly one of the following options. PRs that leave this section blank will be closed."_',
      '',
      '**What to do:** open a new pull request using the full template and tick exactly one disclosure option.',
    ],
    assigned_to_other: [
      `This pull request implements ${issueRefs(issues)}, which is assigned to ${logins(input.assignees ?? [])}.`,
      `The [contributing guide](${GUIDE}#updating-an-existing-cheat-sheet) asks contributors to wait for an issue to be approved and assigned before opening a pull request, so that work is not duplicated.`,
      '',
      '**What to do:** comment on the issue and ask the maintainers or the current assignee whether you can take it over.',
    ],
    no_approved_issue: [
      issues.length
        ? `This pull request changes cheat sheet content, and the issue it references (${issueRefs(issues)}) has not been approved (\`ACK_OBTAINED\`) yet.`
        : 'This pull request changes cheat sheet content but does not reference an approved issue.',
      `The [contributing guide](${GUIDE}#types-of-contributions) says only typos, broken links and small corrections may skip the issue. Updates and new cheat sheets need an approved issue first (the \`update_cheatsheet_proposal\` or \`new_cheatsheet_proposal\` template), which is then assigned to you.`,
      '',
      `**What to do:** [open an issue](${NEW_ISSUE}) describing the change and wait for it to be approved and assigned to you. Then open a pull request that ends with \`This PR fixes issue #<number>.\``,
    ],
  };
  return [
    'Thank you for your contribution. This pull request was closed automatically because it does not follow the OWASP Cheat Sheet Series contributing guide.',
    '',
    ...reason[rule],
    '',
    'If you believe you did follow the guide and this was a mistake, please comment here or open an issue, and a maintainer will review it and reopen the pull request.',
    '',
    `<sub>Closed by the Custodes \`pr-gate\` agent at ${input.now.toISOString().slice(0, 16).replace('T', ' ')} UTC, rule \`${rule}\`. Maintainers are notified of every close.</sub>`,
  ].join('\n');
}
