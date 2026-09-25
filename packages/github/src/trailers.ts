export interface TrailerInput {
  agentId: string;
  agentVersion: string;
  attestationId: string;
  onBehalfOf?: string;
  /** Base URL of the public verify endpoint, e.g. https://custodes.work/verify */
  verifyUrl?: string;
}

/**
 * Every comment an agent posts carries a visible footer and a machine-readable HTML comment,
 * so that anyone can tell which agent acted, for whom, and can verify the attestation.
 */
export function buildTrailers(input: TrailerInput): string {
  const lines = [
    `Custodes-Agent: ${input.agentId}@${input.agentVersion}`,
    `Custodes-Attestation: ${input.attestationId}`,
  ];
  if (input.onBehalfOf) lines.push(`On-Behalf-Of: @${input.onBehalfOf}`);
  const visible = lines.join(' · ');
  const link = input.verifyUrl ? ` · [verify](${input.verifyUrl}/${input.attestationId})` : '';
  return `\n\n---\n<sub>🛡️ ${visible}${link}</sub>\n<!--\n${lines.join('\n')}\n-->`;
}

export function appendTrailers(body: string, input: TrailerInput): string {
  return body.trimEnd() + buildTrailers(input);
}

/** Parses trailers back out of a comment body (used by the CLI and by tests). */
export function parseTrailers(
  body: string,
): Partial<Record<'Custodes-Agent' | 'Custodes-Attestation' | 'On-Behalf-Of', string>> {
  const m = /<!--\n([\s\S]*?)\n-->/.exec(body);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of (m[1] ?? '').split('\n')) {
    const idx = line.indexOf(': ');
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 2);
  }
  return out;
}
