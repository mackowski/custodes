import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CliConfig } from './config.js';

const exec = promisify(execFile);

/**
 * Two ways in, both through Cloudflare Access:
 *  - humans: `cloudflared access login <app>` once, then we read the token with
 *    `cloudflared access token -app=<app>` and send it as `cf-access-token`;
 *  - automation: an Access service token in CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET.
 */
export async function authHeaders(cfg: CliConfig): Promise<Record<string, string>> {
  if (cfg.serviceToken) {
    return {
      'CF-Access-Client-Id': cfg.serviceToken.clientId,
      'CF-Access-Client-Secret': cfg.serviceToken.clientSecret,
    };
  }
  try {
    const { stdout } = await exec('cloudflared', ['access', 'token', `-app=${cfg.accessAppUrl}`]);
    const token = stdout.trim();
    if (!token) throw new Error('empty token');
    return { 'cf-access-token': token };
  } catch (err) {
    const hint = `run: cloudflared access login ${cfg.accessAppUrl}`;
    throw new Error(`could not obtain a Cloudflare Access token (${hint})`, { cause: err });
  }
}
