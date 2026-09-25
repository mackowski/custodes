export interface CliConfig {
  /** Base URL of the gateway, e.g. https://custodes.work */
  apiUrl: string;
  /** Access application URL used for `cloudflared access token -app=...`; defaults to `<apiUrl>/admin`,
   * the primary destination of the Access application. */
  accessAppUrl: string;
  serviceToken?: { clientId: string; clientSecret: string };
  json: boolean;
}

export function loadConfig(opts: { json?: boolean; apiUrl?: string }): CliConfig {
  const apiUrl = (opts.apiUrl ?? process.env['CUSTODES_API_URL'] ?? '').replace(/\/$/, '');
  if (!apiUrl) throw new Error('set CUSTODES_API_URL (or --api-url) to the gateway URL');
  const clientId = process.env['CF_ACCESS_CLIENT_ID'];
  const clientSecret = process.env['CF_ACCESS_CLIENT_SECRET'];
  return {
    apiUrl,
    accessAppUrl: process.env['CUSTODES_ACCESS_APP_URL'] ?? `${apiUrl}/admin`,
    ...(clientId && clientSecret ? { serviceToken: { clientId, clientSecret } } : {}),
    json: opts.json ?? false,
  };
}
