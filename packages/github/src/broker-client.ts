import { BrokerResponse, type BrokerRequest } from '@custodes/schema';

export interface FetcherLike {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** Thin client for the broker's `/v1/act`; used by agents through a service binding. */
export class BrokerClient {
  constructor(private readonly fetcher: FetcherLike) {}

  async act(request: BrokerRequest): Promise<BrokerResponse> {
    const res = await this.fetcher.fetch('https://broker.internal/v1/act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    return BrokerResponse.parse(await res.json());
  }
}
