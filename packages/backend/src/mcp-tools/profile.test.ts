import { describe, expect, it } from 'vitest';
import { profileIncludes, resolveMcpToolProfile } from './profile';
import { listToolNamesForProfile } from './register';

describe('resolveMcpToolProfile', () => {
  it('defaults to standard', () => {
    expect(resolveMcpToolProfile(undefined)).toBe('standard');
    expect(resolveMcpToolProfile('')).toBe('standard');
  });

  it('accepts known profiles', () => {
    expect(resolveMcpToolProfile('runtime')).toBe('runtime');
    expect(resolveMcpToolProfile('legacy')).toBe('legacy');
  });

  it('falls back on unknown values (including removed extended)', () => {
    expect(resolveMcpToolProfile('kitchen-sink')).toBe('standard');
    expect(resolveMcpToolProfile('extended')).toBe('standard');
    expect(resolveMcpToolProfile('full')).toBe('standard');
  });
});

describe('tool tiers by profile', () => {
  it('runtime stays under the recommended budget', () => {
    const names = listToolNamesForProfile('runtime');
    expect(names.length).toBeLessThanOrEqual(12);
    expect(names).toContain('bind_workspace');
    expect(names).toContain('call_service_tool');
    expect(names).not.toContain('manage_deck_card');
    expect(names).not.toContain('create_deck');
  });

  it('standard includes admin elevation tools and editing tools', () => {
    const names = listToolNamesForProfile('standard');
    expect(names).toContain('manage_deck_card');
    expect(names).toContain('list_collection');
    expect(names).toContain('create_deck');
    expect(names).toContain('request_admin_elevation');
    expect(names).toContain('exit_admin_mode');
    expect(names).not.toContain('delete_service');
    expect(names).not.toContain('delete_playbook');
    expect(names).not.toContain('add_service_to_bound_deck');
    expect(names).not.toContain('list_playbooks');
    expect(names.length).toBeLessThanOrEqual(20);
  });

  it('legacy adds deprecated aliases', () => {
    const names = listToolNamesForProfile('legacy');
    expect(names).toContain('add_service_to_bound_deck');
    expect(names).toContain('list_bound_deck_services');
    expect(names.length).toBeGreaterThan(listToolNamesForProfile('standard').length);
  });

  it('profileIncludes matches tier rules', () => {
    expect(profileIncludes('runtime', 'runtime')).toBe(true);
    expect(profileIncludes('runtime', 'editing')).toBe(false);
    expect(profileIncludes('standard', 'editing')).toBe(true);
    expect(profileIncludes('standard', 'legacy')).toBe(false);
    expect(profileIncludes('legacy', 'legacy')).toBe(true);
  });
});
