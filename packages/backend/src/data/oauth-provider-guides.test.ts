import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getOAuthProviderGuide,
  getSlackMcpAppManifest,
  inferOAuthProvider,
  resolveOAuthSetupMode,
} from './oauth-provider-guides';
import { hasSharedOAuthApp } from '../config/shared-oauth-apps';

describe('oauth-provider-guides', () => {
  // The guides quote the default dashboard host/port; an ambient HOST/PORT must
  // not decide what these assertions expect (same guard as oauth-redirect.test).
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.HOST;
    delete process.env.PORT;
  });

  afterEach(() => {
    process.env = env;
  });

  it('marks figma as unavailable', () => {
    expect(resolveOAuthSetupMode('figma', false)).toBe('unavailable');
    expect(getOAuthProviderGuide('figma').unavailableReason).toContain('Figma');
  });

  it('marks google and slack as manual', () => {
    expect(resolveOAuthSetupMode('google', false)).toBe('manual');
    expect(resolveOAuthSetupMode('slack', false)).toBe('manual');
    expect(getOAuthProviderGuide('google').redirectUri).toBe('http://127.0.0.1:8000/api/oauth/callback');
    const slack = getOAuthProviderGuide('slack');
    expect(slack.manifestJson).toBeTruthy();
    expect(slack.createAppUrl).toContain('api.slack.com');
    const manifest = JSON.parse(getSlackMcpAppManifest());
    expect(manifest.oauth_config.redirect_urls[0]).toBe('http://127.0.0.1:8000/api/oauth/callback');
  });

  it('uses managed mode for slack when shared app env is set', () => {
    process.env.AGENT_DECK_SLACK_CLIENT_ID = 'id';
    process.env.AGENT_DECK_SLACK_CLIENT_SECRET = 'secret';
    expect(hasSharedOAuthApp('slack')).toBe(true);
    expect(resolveOAuthSetupMode('slack', false)).toBe('managed');
    expect(getOAuthProviderGuide('slack').setupMode).toBe('managed');
    delete process.env.AGENT_DECK_SLACK_CLIENT_ID;
    delete process.env.AGENT_DECK_SLACK_CLIENT_SECRET;
  });

  it('infers providers from MCP URLs', () => {
    expect(inferOAuthProvider('https://calendarmcp.googleapis.com/mcp/v1')).toBe('google');
    expect(inferOAuthProvider('https://mcp.slack.com/mcp')).toBe('slack');
    expect(inferOAuthProvider('https://mcp.figma.com/mcp')).toBe('figma');
    expect(inferOAuthProvider('https://mcp.draw.io/mcp')).toBe('drawio');
    expect(inferOAuthProvider('https://api.githubcopilot.com/mcp/')).toBe('github');
  });

  it('documents GitHub MCP BYO OAuth path', () => {
    const github = getOAuthProviderGuide('github');
    expect(github.title).toBe('GitHub MCP');
    expect(github.summary).toMatch(/any GitHub account/i);
    expect(github.prerequisites?.some((p) => /OAuth App/i.test(p))).toBe(true);
    expect(github.prerequisites?.some((p) => /Copilot subscription/i.test(p))).toBe(false);
    expect(github.createAppUrl).toContain('github.com');
    expect(github.steps.some((s) => s.includes('Authorization callback URL'))).toBe(true);
    expect(github.tokenAlternative).toMatch(/PAT|Bearer/i);
  });

  it('uses informational mode for draw.io', () => {
    expect(resolveOAuthSetupMode('drawio', false)).toBe('informational');
    const drawio = getOAuthProviderGuide('drawio');
    expect(drawio.setupMode).toBe('informational');
    expect(drawio.steps.length).toBeGreaterThan(0);
  });

  it('tailors Google Drive steps and points to workaround', () => {
    const drive = getOAuthProviderGuide('google', { serviceName: 'Google Drive' });
    expect(drive.steps.some((s) => /drivemcp\.googleapis\.com/i.test(s))).toBe(true);
    expect(drive.easierAlternative).toMatch(/GOOGLE_DRIVE_WORKAROUND/i);
  });
});
