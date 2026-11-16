// Step F: the source Worker as the clean-up PR leaves custodes-agents: no Durable Object class in
// its code at all, only the `transferred` tombstone in its config (source-no-class.jsonc).
export default {
  fetch: () => Response.json({ bound: false, note: 'no Durable Object class in this Worker' }),
};
