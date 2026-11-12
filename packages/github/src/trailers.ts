export interface TrailerInput {
  agentId: string;
  agentVersion: string;
  attestationId: string;
  onBehalfOf?: string;
  /** Base URL of the public verify endpoint, e.g. https://custodes.work/verify */
  verifyUrl?: string;
  /**
   * `hidden`: only the HTML comment, no visible footer (policy `trailer`, ADR 0019). The
   * attestation stays machine-readable for /verify and parseTrailers.
   */
  visibility?: 'visible' | 'hidden';
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
  const hidden = `\n<!--\n${lines.join('\n')}\n-->`;
  if (input.visibility === 'hidden') return `\n${hidden}`;
  const visible = lines.join(' · ');
  const link = input.verifyUrl ? ` · [verify](${input.verifyUrl}/${input.attestationId})` : '';
  return `\n\n---\n<sub>🛡️ ${visible}${link}</sub>${hidden}`;
}

export function appendTrailers(body: string, input: TrailerInput): string {
  return body.trimEnd() + buildTrailers(input);
}

/** Parses trailers back out of a comment body (used by the CLI and by tests). */
export function parseTrailers(
  body: string,
): Partial<Record<'Custodes-Agent' | 'Custodes-Attestation' | 'On-Behalf-Of', string>> {
  const out: Record<string, string> = {};
  // indexOf, not a lazy regex: comment bodies are untrusted and a regex here is quadratic.
  const open = body.indexOf('<!--\n');
  const close = open < 0 ? -1 : body.indexOf('\n-->', open + 5);
  if (close < 0) return out;
  for (const line of body.slice(open + 5, close).split('\n')) {
    const idx = line.indexOf(': ');
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 2);
  }
  return out;
}
