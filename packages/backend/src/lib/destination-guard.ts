import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

export type DestinationCategory = 'loopback' | 'private' | 'metadata';

export type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export type DestinationResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export class DestinationGuardError extends Error {
  constructor(readonly category: DestinationCategory) {
    super(`Blocked ${category} destination in hosted mode`);
    this.name = 'DestinationGuardError';
  }
}

const defaultResolver: DestinationResolver = async (hostname) => {
  if (isIP(hostname)) {
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  }
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

function parseIpv4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (
    octets.some(
      (part, index) =>
        !Number.isInteger(part) || part < 0 || part > 255 || String(part) !== parts[index],
    )
  ) {
    return null;
  }
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function parseIpv6(address: string): bigint | null {
  const zoneIndex = address.indexOf('%');
  let input = (zoneIndex === -1 ? address : address.slice(0, zoneIndex)).toLowerCase();
  const dottedIndex = input.lastIndexOf(':');
  if (input.includes('.') && dottedIndex !== -1) {
    const ipv4 = parseIpv4(input.slice(dottedIndex + 1));
    if (ipv4 === null) return null;
    input = `${input.slice(0, dottedIndex)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

export function classifyDeniedAddress(address: string): DestinationCategory | null {
  if (isIP(address) === 4) {
    const value = parseIpv4(address);
    if (value === null) return 'private';
    if (value === 0xa9fea9fe) return 'metadata';
    if ((value >>> 24) === 127) return 'loopback';
    if (
      (value >>> 24) === 10 ||
      (value >>> 20) === 0xac1 ||
      (value >>> 16) === 0xc0a8 ||
      (value >>> 16) === 0xa9fe ||
      (value >>> 22) === 0x191 ||
      (value >>> 24) === 0
    ) {
      return 'private';
    }
    return null;
  }

  if (isIP(address) === 6) {
    const value = parseIpv6(address);
    if (value === null) return 'private';
    if ((value >> 32n) === 0xffffn) {
      const mapped = Number(value & 0xffffffffn);
      return classifyDeniedAddress(
        `${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`,
      );
    }
    if (value === 0n) return 'private';
    if (value === 1n) return 'loopback';
    if ((value >> 121n) === 0x7en || (value >> 118n) === 0x3fan) return 'private';
    return null;
  }

  return 'private';
}

export class DestinationGuard {
  constructor(
    private readonly resolver: DestinationResolver = defaultResolver,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get enabled(): boolean {
    return (
      this.env.AGENT_DECK_HOSTED_MODE === '1' &&
      this.env.AGENT_DECK_ALLOW_PRIVATE_DESTINATIONS !== '1'
    );
  }

  async assertUrlAllowed(input: string | URL): Promise<void> {
    if (!this.enabled) return;
    const url = input instanceof URL ? input : new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Remote service destinations must use HTTP or HTTPS');
    }
    await this.resolveAndValidate(url.hostname);
  }

  async resolveAndValidate(hostname: string): Promise<ResolvedAddress[]> {
    if (!this.enabled) return [];
    const normalized = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (normalized === 'localhost') throw new DestinationGuardError('loopback');
    if (normalized.endsWith('.internal')) throw new DestinationGuardError('private');

    const literalFamily = isIP(normalized);
    if (literalFamily) {
      const category = classifyDeniedAddress(normalized);
      if (category) throw new DestinationGuardError(category);
      return [{ address: normalized, family: literalFamily as 4 | 6 }];
    }

    const answers = await this.resolver(normalized);
    if (answers.length === 0) throw new Error('Remote destination hostname did not resolve');
    for (const { address } of answers) {
      const category = classifyDeniedAddress(address);
      if (category) throw new DestinationGuardError(category);
    }
    return answers;
  }
}

export const destinationGuard = new DestinationGuard();

export type GuardedRequestState = {
  url: URL;
  method: string;
  headers: Headers;
  body?: Buffer;
  signal?: AbortSignal;
  redirect: 'error' | 'follow' | 'manual';
};

export type GuardedRequester = (
  state: GuardedRequestState,
  guard: DestinationGuard,
) => Promise<Response>;

async function requestOnce(state: GuardedRequestState, guard: DestinationGuard): Promise<Response> {
  const requestModule = state.url.protocol === 'https:' ? https : http;
  const Agent = state.url.protocol === 'https:' ? https.Agent : http.Agent;
  const agent = guard.enabled
    ? new Agent({
        keepAlive: false,
        lookup: ((
          hostname: string,
          options: { all?: boolean },
          callback: (...args: unknown[]) => void,
        ) => {
          guard.resolveAndValidate(hostname).then(
            (answers) =>
              options.all
                ? callback(null, answers)
                : callback(null, answers[0].address, answers[0].family),
            (error) => callback(error),
          );
        }) as never,
      })
    : undefined;

  return new Promise<Response>((resolve, reject) => {
    const request = requestModule.request(
      state.url,
      {
        method: state.method,
        headers: Object.fromEntries(state.headers.entries()),
        agent,
        signal: state.signal,
      },
      (response) => {
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
        }
        const noBody = state.method === 'HEAD' || [204, 205, 304].includes(response.statusCode ?? 0);
        const body = noBody ? null : (Readable.toWeb(response) as ReadableStream);
        resolve(
          new Response(body, {
            status: response.statusCode ?? 500,
            statusText: response.statusMessage,
            headers,
          }),
        );
      },
    );
    request.once('error', reject);
    if (state.body) request.write(state.body);
    request.end();
  });
}

function redirectedState(
  state: GuardedRequestState,
  response: Response,
  location: string,
): GuardedRequestState {
  const nextUrl = new URL(location, state.url);
  const headers = new Headers(state.headers);
  if (nextUrl.origin !== state.url.origin) {
    headers.delete('authorization');
    headers.delete('cookie');
    headers.delete('proxy-authorization');
  }
  const becomesGet =
    response.status === 303 ||
    ((response.status === 301 || response.status === 302) && state.method === 'POST');
  if (becomesGet) {
    headers.delete('content-length');
    headers.delete('content-type');
  }
  return {
    ...state,
    url: nextUrl,
    method: becomesGet ? 'GET' : state.method,
    headers,
    body: becomesGet ? undefined : state.body,
  };
}

async function followRedirects(
  state: GuardedRequestState,
  guard: DestinationGuard,
  remaining = 20,
  requester: GuardedRequester = requestOnce,
): Promise<Response> {
  await guard.assertUrlAllowed(state.url);
  const response = await requester(state, guard);
  const location = response.headers.get('location');
  if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
  if (state.redirect === 'manual') return response;
  if (state.redirect === 'error') throw new TypeError('Redirect encountered while redirect mode is error');
  if (remaining === 0) throw new TypeError('Maximum redirect count exceeded');
  await response.body?.cancel();
  return followRedirects(
    redirectedState(state, response, location),
    guard,
    remaining - 1,
    requester,
  );
}

/** Fetch-compatible HTTP client with hosted-mode destination and redirect validation. */
export async function guardedFetch(
  input: string | URL | Request,
  init?: RequestInit,
  guard: DestinationGuard = destinationGuard,
  requester?: GuardedRequester,
): Promise<Response> {
  if (!guard.enabled) return fetch(input, init);
  const request = new Request(input, init);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  return followRedirects(
    {
      url: new URL(request.url),
      method: request.method,
      headers: new Headers(request.headers),
      body,
      signal: request.signal,
      redirect: request.redirect,
    },
    guard,
    20,
    requester,
  );
}
