// Throwaway Worker for testing a Durable Object transfer (ADR 0018, docs/runbooks/agent-cutover.md).
// Deployed twice: as custodes-transfer-test-source and as custodes-transfer-test-target. Nothing
// here touches Custodes resources. Delete both Workers when the test is done.
import { DurableObject } from 'cloudflare:workers';

export class Probe extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
  }
  async fetch(request) {
    const url = new URL(request.url);
    const sql = this.ctx.storage.sql;
    if (url.pathname === '/set') {
      sql.exec('INSERT OR REPLACE INTO kv VALUES (?, ?)', 'value', url.searchParams.get('v') ?? '');
      // An alarm far enough out to still be pending after the transfer.
      await this.ctx.storage.setAlarm(
        Date.now() + Number(url.searchParams.get('alarmIn') ?? 600_000),
      );
    }
    const row = sql.exec("SELECT v FROM kv WHERE k = 'value'").toArray()[0];
    const fired = sql.exec("SELECT v FROM kv WHERE k = 'alarm_fired'").toArray()[0];
    return Response.json({
      script: this.env.SCRIPT,
      id: this.ctx.id.toString(),
      value: row?.v ?? null,
      alarm: await this.ctx.storage.getAlarm(),
      alarmFiredAt: fired?.v ?? null,
    });
  }
  async alarm() {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO kv VALUES (?, ?)',
      'alarm_fired',
      new Date().toISOString(),
    );
  }
}

export default {
  async fetch(request, env) {
    if (!env.PROBE) return Response.json({ script: env.SCRIPT, bound: false });
    // Same names in both Workers: after the transfer they must reach the same objects and data.
    // Two objects, as pr-gate has two instances (owasp-cheatsheetseries, custodes-sandbox).
    const name = new URL(request.url).searchParams.get('name') === 'b' ? 'probe-b' : 'probe-a';
    return env.PROBE.get(env.PROBE.idFromName(name)).fetch(request);
  },
};
