export type OAuthSetupMode = 'dynamic' | 'managed' | 'manual' | 'unavailable' | 'informational';

import { hasSharedOAuthApp } from '../config/shared-oauth-apps';
import { getOAuthRedirectUri, isOAuthRedirectHttps } from '../config/oauth-redirect';

export type ServiceGuideContext = {
  serviceName?: string;
  serviceUrl?: string;
};

export type OAuthProviderGuide = {
  provider: string;
  setupMode: OAuthSetupMode;
  title: string;
  redirectUri: string;
  /** One-line: what this card does in Agent Deck. */
  summary?: string;
  prerequisites?: string[];
  steps: string[];
  /** What to do after OAuth / first successful tool discovery. */
  afterConnect?: string[];
  docsUrl?: string;
  unavailableReason?: string;
  /** Pre-filled app manifest (Slack: paste at Create New App → From a manifest). */
  manifestJson?: string;
  /** Deep link to provider app creation UI. */
  createAppUrl?: string;
  createAppLabel?: string;
  /** Shorter alternative when full setup is too heavy. */
  easierAlternative?: string;
  /** PAT / header auth when OAuth app setup is optional. */
  tokenAlternative?: string;
};

const AFTER_DECK_HINT =
  'Drag this card onto a deck in the dashboard, then bind your agent (bind_workspace) so tools appear in chat.';

/** Slack MCP app manifest with redirect URI and common user scopes pre-filled. */
export function getSlackMcpAppManifest(redirectUri = getOAuthRedirectUri()): string {
  return JSON.stringify(
    {
      display_information: {
        name: 'Agent Deck',
        description: 'Connect AI agents to your Slack workspace through Agent Deck.',
        long_description:
          'Agent Deck lets you authorize Slack so AI agents can read and search channels and direct messages you belong to, and send messages when you approve. Each user connects with their own Slack account. Tokens are stored on your Agent Deck instance.',
        background_color: '#2c2d30',
      },
      features: {
        bot_user: {
          display_name: 'Agent Deck MCP',
          always_online: false,
        },
      },
      oauth_config: {
        redirect_urls: [redirectUri],
        scopes: {
          bot: ['users:read'],
          user: [
            'search:read.public',
            'search:read.private',
            'search:read.mpim',
            'search:read.im',
            'search:read.files',
            'search:read.users',
            'chat:write',
            'channels:history',
            'groups:history',
            'mpim:history',
            'im:history',
            'canvases:read',
            'canvases:write',
            'users:read',
            'users:read.email',
          ],
        },
      },
      settings: {
        org_deploy_enabled: true,
      },
    },
    null,
    2,
  );
}

export function inferOAuthProvider(serviceUrl: string, authServers: string[] = []): string {
  const url = serviceUrl.toLowerCase();
  if (url.includes('figma.com')) return 'figma';
  if (url.includes('draw.io')) return 'drawio';
  if (url.includes('slack.com')) return 'slack';
  if (url.includes('googleapis.com') || authServers.some((s) => s.includes('accounts.google.com'))) {
    return 'google';
  }
  if (url.includes('linear.app')) return 'linear';
  if (url.includes('notion.com')) return 'notion';
  if (url.includes('githubcopilot.com') || authServers.some((s) => s.includes('github.com'))) {
    return 'github';
  }
  return 'custom';
}

export function resolveOAuthSetupMode(
  provider: string,
  supportsDynamicRegistration?: boolean,
): OAuthSetupMode {
  if (provider === 'figma') return 'unavailable';
  if (provider === 'drawio') return 'informational';
  if (hasSharedOAuthApp(provider)) return 'managed';
  if (supportsDynamicRegistration) return 'dynamic';
  if (provider === 'linear' || provider === 'notion') return 'dynamic';
  return 'manual';
}

function googleApiSteps(serviceName?: string): string[] {
  const name = serviceName?.toLowerCase() ?? '';
  if (name.includes('gmail')) {
    return [
      'In Google Cloud Console → APIs & Services → Library, enable the Gmail API for this project.',
      'OAuth consent screen: add scope https://www.googleapis.com/auth/gmail (and any others Gmail MCP requests).',
    ];
  }
  if (name.includes('calendar')) {
    return [
      'Enable the Google Calendar API in APIs & Services → Library.',
      'OAuth consent screen: allow Calendar scopes when prompted during Connect.',
    ];
  }
  if (name.includes('drive')) {
    return [
      'Enable Google Drive API (drive.googleapis.com) in APIs & Services → Library.',
      'Enable Google Drive MCP API (drivemcp.googleapis.com) — required for the remote MCP endpoint; easy to miss.',
      'OAuth consent screen → Data access → manually add scopes: drive.readonly and drive.file (see Google Drive MCP docs).',
      'If app user type is External: Audience → add your Google account as a Test user while the app is in Testing.',
    ];
  }
  return ['Enable the Gmail, Calendar, or Drive API that matches this card.'];
}

export function getOAuthProviderGuide(
  provider: string,
  context: ServiceGuideContext = {},
): OAuthProviderGuide {
  const redirectUri = getOAuthRedirectUri();
  const base = {
    provider,
    redirectUri,
  };

  switch (provider) {
    case 'google': {
      const isDrive = context.serviceName?.toLowerCase().includes('drive');
      return {
        ...base,
        setupMode: 'manual',
        title: context.serviceName ?? 'Google MCP',
        summary: isDrive
          ? 'Google-hosted Drive MCP (Developer Preview). Heavy GCP setup — see docs/GOOGLE_DRIVE_WORKAROUND.md for a simpler local-MCP path.'
          : 'Google-hosted MCP for Workspace data. One OAuth client can cover multiple Google cards after Drive works.',
        prerequisites: [
          'Google account with access to the data you want.',
          'Google Cloud project (free tier OK for personal use).',
          ...(isDrive
            ? ['Remote Drive MCP: enable both drive.googleapis.com and drivemcp.googleapis.com.']
            : []),
        ],
        docsUrl: isDrive
          ? 'https://developers.google.com/workspace/drive/api/guides/configure-mcp-server'
          : 'https://developers.google.com/workspace/guides/configure-mcp-servers',
        createAppUrl: 'https://console.cloud.google.com/apis/credentials',
        createAppLabel: 'Open Google Cloud Credentials',
        steps: [
          'Open Google Cloud Console → select or create a project.',
          ...googleApiSteps(context.serviceName),
          'Google Auth Platform → OAuth consent screen → configure (External + Test users for personal dev is OK).',
          'Credentials → Create credentials → OAuth client ID → Web application.',
          `Authorized redirect URIs: add exactly ${redirectUri} (127.0.0.1 not localhost if you see redirect_uri_mismatch).`,
          'Copy Client ID and Client Secret → paste below → Connect with credentials → pick your Google account.',
        ],
        afterConnect: [
          'If OAuth succeeds but tools fail, confirm drivemcp.googleapis.com is enabled (Drive) or the product MCP API for Gmail/Calendar.',
          AFTER_DECK_HINT,
        ],
        easierAlternative: isDrive
          ? 'Recommended if remote OAuth failed: register a local Google Drive MCP server (stdio) — full steps in docs/GOOGLE_DRIVE_WORKAROUND.md. Or use Drive in Cursor/Claude natively and skip this card.'
          : 'You only need one GCP project for all three Google cards. Debug Google Drive first; reuse the same Client ID/Secret on other cards once scopes are added.',
      };
    }
    case 'slack':
      if (hasSharedOAuthApp('slack')) {
        return {
          ...base,
          setupMode: 'managed',
          title: 'Slack MCP',
          summary: 'Official Slack MCP — search channels/DMs, read history, send messages as you.',
          docsUrl: 'https://docs.slack.dev/ai/slack-mcp-server/',
          steps: [
            'Click Connect — Agent Deck uses the shared Slack OAuth app.',
            'Sign in and approve access for your workspace (once per workspace).',
          ],
          afterConnect: [AFTER_DECK_HINT],
        };
      }
      return {
        ...base,
        setupMode: 'manual',
        title: 'Slack MCP (~10 min, one-time)',
        summary:
          'Official Slack MCP at mcp.slack.com. Requires your own Slack app with MCP enabled (Slack does not allow auto-registration like Linear).',
        prerequisites: [
          'Slack workspace where you can create or manage apps.',
          'Permission to install the app to that workspace.',
        ],
        docsUrl: 'https://docs.slack.dev/ai/slack-mcp-server/',
        createAppUrl: 'https://api.slack.com/apps/new',
        createAppLabel: 'Open Slack app creator',
        manifestJson: getSlackMcpAppManifest(redirectUri),
        easierAlternative:
          'Easier path: use Slack MCP inside Cursor or Claude Code (partner OAuth). Use Agent Deck when you want Slack on a custom deck with other tools.',
        steps: [
          ...(isOAuthRedirectHttps()
            ? []
            : [
                'Dev / single workspace: redirect URI above (http on 127.0.0.1) is fine. Other workspaces need HTTPS — set AGENT_DECK_PUBLIC_URL when you host.',
              ]),
          'Copy manifest → Open Slack app creator → Create New App → From a manifest → paste → Create.',
          'In the app: Agents & AI Apps → enable Model Context Protocol (MCP).',
          'OAuth & Permissions → enable PKCE if shown; confirm redirect URL matches above.',
          'Basic Information → copy Client ID and Client Secret → paste below → Connect → approve in browser.',
        ],
        afterConnect: [
          'If tools fail with “App is not enabled for Slack MCP”, enable MCP under Agents & AI Apps.',
          AFTER_DECK_HINT,
        ],
      };
    case 'figma':
      return {
        ...base,
        setupMode: 'unavailable',
        title: 'Figma remote MCP',
        docsUrl: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/',
        unavailableReason:
          'Figma remote MCP only allows OAuth from approved clients (Cursor, Claude Code, VS Code). Agent Deck cannot complete OAuth until Figma opens third-party registration. Use Figma in your agent app directly, or add a local MCP with a Figma personal access token.',
        steps: [],
      };
    case 'github':
      return {
        ...base,
        setupMode: 'manual',
        title: 'GitHub MCP',
        summary:
          'GitHub’s hosted MCP at api.githubcopilot.com — repos, issues, PRs, Actions, code search. Available to any GitHub account; only certain tools (e.g. Copilot Cloud Agent) need a paid Copilot plan.',
        prerequisites: [
          'GitHub account with access to the repos you want the agent to touch.',
          'Permission to create an OAuth App (personal account) or org admin approval for org-owned apps.',
          'Org/enterprise: admins may need to allow this OAuth app / MCP for non-partner clients (Cursor/VS Code are pre-approved; Agent Deck is BYO).',
        ],
        docsUrl:
          'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server',
        createAppUrl: 'https://github.com/settings/applications/new',
        createAppLabel: 'Create GitHub OAuth App',
        easierAlternative:
          'Easier in one IDE: built-in GitHub MCP in Cursor or VS Code (one-click OAuth). Use Agent Deck when GitHub must share a deck with Linear, Slack, etc.',
        tokenAlternative:
          'Skip OAuth app: edit this card → Headers → Authorization: Bearer <fine-grained PAT> with the repo scopes you need. Rotate PATs manually.',
        steps: [
          'GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.',
          'Application name: e.g. Agent Deck (local). Homepage URL: your Agent Deck URL or http://127.0.0.1:8000.',
          `Authorization callback URL: ${redirectUri} (must match exactly — use Copy redirect URI below).`,
          'Register the app → copy Client ID → Generate a new client secret.',
          'Paste Client ID and Client Secret below → Connect with credentials → approve GitHub access in the browser tab.',
          'Return here; health should turn green and tools (issues, PRs, repos, …) should appear.',
        ],
        afterConnect: [
          'Some tools need extra licenses (e.g. Copilot Cloud Agent → Copilot plan; code scanning → GHAS). Most repo/issue/PR tools work on free GitHub.',
          AFTER_DECK_HINT,
        ],
      };
    case 'linear':
      return {
        ...base,
        setupMode: 'dynamic',
        title: 'Linear',
        summary: 'Official Linear MCP — issues, projects, cycles, and team workflows.',
        docsUrl: 'https://linear.app/docs/mcp',
        steps: [
          'Click Connect — Agent Deck auto-registers with Linear (no developer console).',
          'Complete sign-in in the browser tab Linear opens.',
          'When status shows authenticated, refresh tools on this card.',
        ],
        afterConnect: [AFTER_DECK_HINT],
      };
    case 'notion':
      return {
        ...base,
        setupMode: 'dynamic',
        title: 'Notion',
        summary: 'Official Notion MCP — pages, databases, and workspace search.',
        docsUrl: 'https://developers.notion.com/docs/mcp',
        steps: [
          'Click Connect — Agent Deck auto-registers with Notion.',
          'Pick the workspace and approve access in the browser.',
          'Refresh tools once authenticated.',
        ],
        afterConnect: [AFTER_DECK_HINT],
      };
    case 'drawio':
      return {
        ...base,
        setupMode: 'informational',
        title: 'Draw.io MCP',
        summary:
          'Hosted diagrams MCP at mcp.draw.io. Often works without OAuth — open tools on this card first.',
        docsUrl: 'https://www.drawio.com/blog/mcp-server',
        steps: [
          'Open this card → check Connection Logs / Tools tab. Many users get tools with no setup.',
          'If tools load: drag the card onto a deck and bind your agent — you are done.',
          'If discovery fails: check draw.io MCP docs for auth requirements; you may need a draw.io account or API token in card Headers.',
        ],
        afterConnect: [AFTER_DECK_HINT],
      };
    default:
      return {
        ...base,
        setupMode: 'manual',
        title: context.serviceName ?? 'OAuth application',
        summary: 'Connect this MCP server with a provider-registered OAuth application.',
        steps: [
          'Create an OAuth app in the provider developer console.',
          `Set redirect URI to: ${redirectUri}`,
          'Paste Client ID and Client Secret below, then Connect.',
        ],
        afterConnect: [AFTER_DECK_HINT],
      };
  }
}

export { getOAuthRedirectUri } from '../config/oauth-redirect';
