#!/usr/bin/env node
// PreToolUse(Read|Edit|Write|Grep): never open, write or search files that hold secrets.
// Runs with no condition; the rules are in secret-paths.mjs. Anything unexpected refuses the call.
/** @param {string} why */
const deny = (why) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: why,
      },
    }),
  );
  process.stderr.write(`${why}\n`);
  process.exitCode = 2;
};

try {
  // Loaded here, so a Node too old for the rules (path.matchesGlob) refuses instead of crashing.
  const { refusal } = await import('./secret-paths.mjs');
  let raw = '';
  for await (const chunk of process.stdin) raw += String(chunk);
  const why = refusal(JSON.parse(raw));
  if (why !== null) deny(why);
} catch {
  deny('the secrets hook could not read this call');
}
