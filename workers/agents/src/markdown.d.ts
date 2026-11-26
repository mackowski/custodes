/** `.md` files are bundled as text (wrangler `rules`, type Text): the agent.md files (ADR 0023). */
declare module '*.md' {
  const text: string;
  export default text;
}
