// The deploy guard's rules (do-namespace-owner.ts), apart from the script so a test can import them.

export interface WranglerConfig {
  exports?: Record<string, { state?: string } | undefined>;
  durable_objects?: { bindings?: { class_name: string; script_name?: string }[] };
}

/**
 * Whether a Worker's config declares the class as its own live Durable Object: an export without a
 * tombstone state, or a binding without `script_name` (a binding with one points at another
 * Worker). This decides what the deploy guard looks at.
 */
export function isLive(config: WranglerConfig, className: string): boolean {
  const exported = config.exports?.[className];
  const liveExport = exported !== undefined && exported.state === undefined;
  const ownBinding = (config.durable_objects?.bindings ?? []).some(
    (b) => b.class_name === className && b.script_name === undefined,
  );
  return liveExport || ownBinding;
}

/** The guard's rule: a Worker may only declare a class live when the namespace is already its own. */
export function mustRefuse(live: boolean, owner: string, script: string): boolean {
  return live && owner !== script;
}
