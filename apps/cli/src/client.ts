import type { z } from 'zod';
import { authHeaders } from './auth.js';
import type { CliConfig } from './config.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`API ${status}: ${body.slice(0, 300)}`);
  }
}

export class ApiClient {
  constructor(
    private readonly cfg: CliConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.cfg.apiUrl}${path}`, {
      method,
      headers: {
        ...(await authHeaders(this.cfg)),
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : null,
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text);
    return schema.parse(JSON.parse(text));
  }
}
