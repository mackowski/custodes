import { env } from 'cloudflare:workers';
import { KillSwitch, type KvLike } from '@custodes/core';

/** The test-only kill-switch namespace (vitest.config.ts); the Worker itself has no binding. */
export const testKillSwitch = (): KillSwitch =>
  new KillSwitch((env as unknown as { KILL_SWITCH: KvLike }).KILL_SWITCH);

type FakeFetch = (url: string, init: RequestInit) => Response | Promise<Response>;

/**
 * Wraps a fake broker so it also answers `/v1/state` like the real one, from the test kill-switch
 * namespace. Every other call goes to the fake unchanged.
 */
export function withHaltState<T extends { fetch: FakeFetch }>(fake: T): T {
  return {
    ...fake,
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      if (url === 'https://broker.internal/v1/state') {
        const { agentId } = JSON.parse(init.body as string) as { agentId: string };
        return Response.json(await testKillSwitch().state(agentId));
      }
      return fake.fetch(url, init);
    },
  };
}
