import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { AgentDeckMCPServer } from './mcp-server';

/**
 * Socket-free regression tests for the NOT-569 wire-id translation.
 *
 * The SDK Express wrapper converts the Node request through Hono's Node
 * adapter, which rebuilds the request headers from `rawHeaders` — never
 * from the parsed `headers` object. Translating `headers` alone therefore
 * leaves the stale id visible to the transport's own session validation,
 * which answers the SDK's own 404 (the round-1 CI failure: every positive
 * recovery test got 404). These tests pin the raw-pairs translation and
 * the exact restore without needing a listener.
 */
describe('recovered session wire-id translation (NOT-569)', () => {
  type TranslationHarness = {
    withPresentedSessionId<T>(
      liveSessionId: string,
      presentedSessionId: string,
      req: Request,
      res: Response,
      serve: () => Promise<T>,
    ): Promise<T>;
  };

  function harness(): TranslationHarness {
    return new AgentDeckMCPServer(
      0,
      'http://127.0.0.1:1',
    ) as unknown as TranslationHarness;
  }

  /** Shaped like a real node IncomingMessage: parsed headers plus raw pairs. */
  function nodeLikeRequest(sessionId: string): Request {
    return {
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      // Node keeps the client's original casing in rawHeaders.
      rawHeaders: [
        'Content-Type',
        'application/json',
        'Accept',
        'application/json, text/event-stream',
        'Mcp-Session-Id',
        sessionId,
      ],
    } as unknown as Request;
  }

  function recordingResponse() {
    const setHeaders: Array<[string, unknown]> = [];
    const writeHeads: Array<{ status: unknown; headers: unknown }> = [];
    const res = {
      setHeader(name: string, value: unknown) {
        setHeaders.push([name, value]);
      },
      writeHead(status: unknown, headers: unknown) {
        writeHeads.push({ status, headers });
      },
    } as unknown as Response;
    return { res, setHeaders, writeHeads };
  }

  function rawSessionValues(req: Request): string[] {
    const raw = req.rawHeaders;
    const values: string[] = [];
    for (let index = 0; index + 1 < raw.length; index += 2) {
      if (raw[index].toLowerCase() === 'mcp-session-id') {
        values.push(raw[index + 1]);
      }
    }
    return values;
  }

  it('translates headers and rawHeaders to the live id while serving, then restores both', async () => {
    const live = 'live-session-id';
    const presented = 'stale-session-id';
    const req = nodeLikeRequest(presented);
    const { res } = recordingResponse();
    const previousRawHeaders = req.rawHeaders;

    await harness().withPresentedSessionId(live, presented, req, res, async () => {
      expect(req.headers['mcp-session-id']).toBe(live);
      // Every raw pair the Hono adapter reads must carry the live id.
      expect(rawSessionValues(req)).toEqual([live]);
      // Untouched pairs keep their values.
      expect(req.rawHeaders).toContain('application/json');
      return 'served';
    });

    // Exact restore: the identical raw array, values back to the stale id.
    expect(req.rawHeaders).toBe(previousRawHeaders);
    expect(req.headers['mcp-session-id']).toBe(presented);
    expect(rawSessionValues(req)).toEqual([presented]);
    expect(previousRawHeaders).toContain(presented);
  });

  it('translates response headers back to the presented id and restores the writers', async () => {
    const live = 'live-session-id';
    const presented = 'stale-session-id';
    const req = nodeLikeRequest(presented);
    const { res, setHeaders, writeHeads } = recordingResponse();
    const pristineSetHeader = res.setHeader;
    const pristineWriteHead = res.writeHead;

    await harness().withPresentedSessionId(live, presented, req, res, async () => {
      res.setHeader('mcp-session-id', live);
      res.setHeader('content-type', 'application/json');
      (res.writeHead as (...args: unknown[]) => void)(
        200,
        { 'content-type': 'application/json', 'mcp-session-id': live },
      );
      return 'served';
    });

    expect(setHeaders[0]).toEqual(['mcp-session-id', presented]);
    expect(setHeaders[1]).toEqual(['content-type', 'application/json']);
    expect(writeHeads).toHaveLength(1);
    expect(writeHeads[0].headers).toEqual({
      'content-type': 'application/json',
      'mcp-session-id': presented,
    });
    expect(res.setHeader).toBe(pristineSetHeader);
    expect(res.writeHead).toBe(pristineWriteHead);
  });

  it('leaves requests without rawHeaders working', async () => {
    const req = { headers: { 'mcp-session-id': 'stale-id' } } as unknown as Request;
    const { res } = recordingResponse();
    const pristineSetHeader = res.setHeader;
    const pristineWriteHead = res.writeHead;

    const result = await harness().withPresentedSessionId(
      'live-id',
      'stale-id',
      req,
      res,
      async () => {
        expect(req.headers['mcp-session-id']).toBe('live-id');
        return 7;
      },
    );

    expect(result).toBe(7);
    expect(req.headers['mcp-session-id']).toBe('stale-id');
    expect(res.setHeader).toBe(pristineSetHeader);
    expect(res.writeHead).toBe(pristineWriteHead);
  });
});
