import { describe, expect, it, vi } from 'vitest';

import {
  classifyDeniedAddress,
  DestinationGuard,
  DestinationGuardError,
  guardedFetch,
  type DestinationResolver,
} from './destination-guard';

describe('classifyDeniedAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.0.1', 'private'],
    ['192.168.255.255', 'private'],
    ['169.254.0.1', 'private'],
    ['169.254.169.254', 'metadata'],
    ['100.64.0.1', 'private'],
    ['100.127.255.255', 'private'],
    ['0.0.0.0', 'private'],
    ['0.255.255.255', 'private'],
    ['::1', 'loopback'],
    ['::', 'private'],
    ['fc00::1', 'private'],
    ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'private'],
    ['fe80::1', 'private'],
    ['febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'private'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:172.16.0.1', 'private'],
    ['::ffff:192.168.0.1', 'private'],
    ['::ffff:169.254.0.1', 'private'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['::ffff:100.64.0.1', 'private'],
    ['::ffff:0.0.0.1', 'private'],
    ['8.8.8.8', null],
    ['2606:4700:4700::1111', null],
  ] as const)('classifies %s as %s', (address, category) => {
    expect(classifyDeniedAddress(address)).toBe(category);
  });
});

describe('DestinationGuard', () => {
  const hosted = { AGENT_DECK_HOSTED_MODE: '1' } as NodeJS.ProcessEnv;

  it('rejects hostnames when any resolved address is private without exposing the address', async () => {
    const guard = new DestinationGuard(
      async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.20.30.40', family: 4 },
      ],
      hosted,
    );

    const error = await guard.assertUrlAllowed('https://example.test/mcp').catch((caught) => caught);
    expect(error).toBeInstanceOf(DestinationGuardError);
    expect(error.message).toBe('Blocked private destination in hosted mode');
    expect(error.message).not.toContain('10.20.30.40');
  });

  it.each([
    ['http://localhost/mcp', 'loopback'],
    ['https://service.internal/mcp', 'private'],
  ])('rejects denied hostname %s as %s', async (url, category) => {
    const resolver = vi.fn<DestinationResolver>();
    const guard = new DestinationGuard(resolver, hosted);
    await expect(guard.assertUrlAllowed(url)).rejects.toMatchObject({ category });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('re-resolves at connect time and rejects DNS rebinding', async () => {
    const resolver = vi
      .fn<DestinationResolver>()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const guard = new DestinationGuard(resolver, hosted);

    await expect(guardedFetch('http://rebind.test/mcp', undefined, guard)).rejects.toMatchObject({
      category: 'loopback',
    });
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('rejects a redirect hop to the cloud metadata address', async () => {
    const resolver = vi
      .fn<DestinationResolver>()
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const guard = new DestinationGuard(resolver, hosted);
    const stubServer = vi.fn(async () =>
      Response.redirect('http://169.254.169.254/latest/meta-data', 302),
    );

    await expect(
      guardedFetch('https://public.example/start', undefined, guard, stubServer),
    ).rejects.toMatchObject({ category: 'metadata' });
    expect(stubServer).toHaveBeenCalledTimes(1);
  });

  it('allows private destinations with the deployment exception', async () => {
    const resolver = vi.fn<DestinationResolver>();
    const guard = new DestinationGuard(resolver, {
      AGENT_DECK_HOSTED_MODE: '1',
      AGENT_DECK_ALLOW_PRIVATE_DESTINATIONS: '1',
    });
    await expect(guard.assertUrlAllowed('http://127.0.0.1')).resolves.toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('leaves local mode unchanged', async () => {
    const resolver = vi.fn<DestinationResolver>();
    const guard = new DestinationGuard(resolver, {});
    await expect(guard.assertUrlAllowed('http://127.0.0.1')).resolves.toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });
});
