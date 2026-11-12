// Step A only: worker.js plus `Gone`, a stand-in for HelloAgent. PR #106 removes HelloAgent's code
// and marks it `deleted` in `exports` in the same deploy as the migrations -> exports switch; step B
// rehearses exactly that (source-exports.jsonc runs worker.js, which no longer has `Gone`).
import { DurableObject } from 'cloudflare:workers';
import worker from './worker.js';

export { Probe } from './worker.js';

export class Gone extends DurableObject {
  async fetch() {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)');
    this.ctx.storage.sql.exec("INSERT INTO t VALUES ('data that the deleted export removes')");
    return Response.json({ gone: this.ctx.id.toString() });
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/gone')
      return env.GONE.get(env.GONE.idFromName('gone')).fetch(request);
    return worker.fetch(request, env);
  },
};
