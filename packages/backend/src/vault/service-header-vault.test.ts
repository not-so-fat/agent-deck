import { describe, expect, it } from 'vitest';

import { MemorySecretStore } from './secret-store';
import { ServiceHeaderVault } from './service-header-vault';

describe('ServiceHeaderVault', () => {
  it('stores and retrieves secret headers keyed by service id', async () => {
    const vault = new ServiceHeaderVault(new MemorySecretStore());
    await vault.set('svc-1', { Authorization: 'Bearer abc', 'X-Api-Key': 'k' });

    expect(await vault.get('svc-1')).toEqual({
      Authorization: 'Bearer abc',
      'X-Api-Key': 'k',
    });
  });

  it('returns null when no secret headers are stored', async () => {
    const vault = new ServiceHeaderVault(new MemorySecretStore());
    expect(await vault.get('missing')).toBeNull();
  });

  it('setting empty headers deletes the entry', async () => {
    const store = new MemorySecretStore();
    const vault = new ServiceHeaderVault(store);
    await vault.set('svc-1', { Authorization: 'Bearer abc' });
    await vault.set('svc-1', {});

    expect(await vault.get('svc-1')).toBeNull();
  });

  it('deletes stored secret headers', async () => {
    const vault = new ServiceHeaderVault(new MemorySecretStore());
    await vault.set('svc-1', { Authorization: 'Bearer abc' });
    await vault.delete('svc-1');
    expect(await vault.get('svc-1')).toBeNull();
  });

  it('keeps separate entries per service', async () => {
    const vault = new ServiceHeaderVault(new MemorySecretStore());
    await vault.set('a', { Authorization: 'Bearer a' });
    await vault.set('b', { Authorization: 'Bearer b' });
    expect(await vault.get('a')).toEqual({ Authorization: 'Bearer a' });
    expect(await vault.get('b')).toEqual({ Authorization: 'Bearer b' });
  });
});
