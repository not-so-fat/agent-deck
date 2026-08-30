import type { AuthPolicy } from './auth';

export type RoutePolicyRule = {
  methods: string[];
  /** Regex against pathname (no query). Use [^/]+ for :param segments. */
  pattern: RegExp;
  policy: AuthPolicy;
};

/**
 * Authoritative HTTP route → policy map (NOT-45 §6).
 * Every /api/* route and /health must match exactly one rule.
 */
export const HTTP_ROUTE_POLICIES: RoutePolicyRule[] = [
  // Public
  { methods: ['GET'], pattern: /^\/health$/, policy: 'allowPublic' },
  { methods: ['GET'], pattern: /^\/$/, policy: 'allowPublic' },
  { methods: ['GET'], pattern: /^\/api\/oauth\/callback$/, policy: 'allowPublic' },
  { methods: ['GET'], pattern: /^\/api\/oauth\/[^/]+\/callback$/, policy: 'allowPublic' },
  { methods: ['GET'], pattern: /^\/api\/services\/[^/]+\/icon$/, policy: 'allowPublic' },
  { methods: ['GET'], pattern: /^\/api\/credentials\/[^/]+\/icon$/, policy: 'allowPublic' },
  { methods: ['GET'], pattern: /^\/api\/scope\/display$/, policy: 'allowPublic' },
  { methods: ['GET'], pattern: /^\/api\/scope\/bindings$/, policy: 'allowPublic' },
  { methods: ['GET'], pattern: /^\/api\/trusted-session\/admin\/challenges$/, policy: 'allowPublic' },
  { methods: ['POST'], pattern: /^\/api\/trusted-session\/mcp\/connect$/, policy: 'allowPublic' },
  { methods: ['POST'], pattern: /^\/api\/dashboard-auth\/bootstrap\/session$/, policy: 'allowPublic' },

  // Trusted writer (admin secret bearer only — enforced in policy hook)
  { methods: ['POST'], pattern: /^\/api\/trusted-session\/workspace-grants\/issue$/, policy: 'requireTrustedWriter' },
  {
    methods: ['POST'],
    pattern: /^\/api\/trusted-session\/workspace-grants\/[^/]+\/revoke-pending$/,
    policy: 'requireTrustedWriter',
  },
  {
    methods: ['POST'],
    pattern: /^\/api\/trusted-session\/workspace-grants\/[^/]+\/activate$/,
    policy: 'requireTrustedWriter',
  },
  { methods: ['POST'], pattern: /^\/api\/dashboard-auth\/bootstrap\/nonce$/, policy: 'requireTrustedWriter' },

  // Agent resource (runtime session or grant bearer)
  { methods: ['GET'], pattern: /^\/api\/trusted-session\/runtime-session$/, policy: 'requireAgentResource' },
  {
    methods: ['POST'],
    pattern: /^\/api\/trusted-session\/admin\/request-elevation$/,
    policy: 'requireAgentResource',
  },
  { methods: ['POST'], pattern: /^\/api\/trusted-session\/admin\/exit$/, policy: 'requireAgentResource' },
  { methods: ['POST'], pattern: /^\/api\/trusted-session\/bind-workspace$/, policy: 'requireAgentResource' },
  { methods: ['GET'], pattern: /^\/api\/scope\/deck$/, policy: 'requireAgentResource' },
  { methods: ['POST'], pattern: /^\/api\/scope\/live-display$/, policy: 'requireAgentResource' },
  { methods: ['DELETE'], pattern: /^\/api\/scope\/live-display\/[^/]+$/, policy: 'requireAgentResource' },
  {
    methods: ['POST'],
    pattern: /^\/api\/scope\/live-display\/[^/]+\/touch$/,
    policy: 'requireAgentResource',
  },
  { methods: ['POST'], pattern: /^\/api\/scope\/deck-workspace$/, policy: 'requireAgentResource' },

  // Deck admin (agent-admin mode)
  { methods: ['POST'], pattern: /^\/api\/decks$/, policy: 'requireDeckAdmin' },

  // Dashboard-only
  { methods: ['GET'], pattern: /^\/api\/decks\/active$/, policy: 'requireDashboard' },
  { methods: ['PUT'], pattern: /^\/api\/decks\/[^/]+$/, policy: 'requireDashboard' },
  { methods: ['DELETE'], pattern: /^\/api\/decks\/[^/]+$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/decks\/[^/]+\/activate$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/services$/, policy: 'requireDashboard' },
  { methods: ['PUT'], pattern: /^\/api\/services\/[^/]+$/, policy: 'requireDashboard' },
  { methods: ['DELETE'], pattern: /^\/api\/services\/[^/]+$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/services\/[^/]+\/refresh-icon$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/services\/[^/]+\/health$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/credentials\/collection$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/credentials\/vault$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/credentials$/, policy: 'requireDashboard' },
  { methods: ['PUT'], pattern: /^\/api\/credentials\/[^/]+$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/credentials\/[^/]+\/rotate$/, policy: 'requireDashboard' },
  { methods: ['DELETE'], pattern: /^\/api\/credentials\/[^/]+$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/playbooks\/collection$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/playbooks\/vault$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/playbooks\/dependents\/check$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/playbooks\/[^/]+\/events\/count$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/playbook-patches$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/playbook-patches\/[^/]+\/preview$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/playbook-patches\/[^/]+\/accept$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/playbook-patches\/[^/]+\/reject$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/feedback-signals$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/feedback-signals\/count$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/feedback-signals\/discard$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/feedback-signals\/import$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/collection\/warnings$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/export$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/import$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/oauth\/[^/]+\/discover$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/oauth\/[^/]+\/setup$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/oauth\/[^/]+\/connect$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/oauth\/[^/]+\/auto-setup$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/oauth\/[^/]+\/authorize$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/oauth\/[^/]+\/refresh$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/oauth\/[^/]+\/status$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/mcp\/discover$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/local-mcp\/import$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/local-mcp\/sample-config$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/local-mcp\/[^/]+\/start$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/local-mcp\/[^/]+\/stop$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/local-mcp\/[^/]+\/status$/, policy: 'requireDashboard' },
  { methods: ['GET'], pattern: /^\/api\/local-mcp\/list$/, policy: 'requireDashboard' },
  { methods: ['POST'], pattern: /^\/api\/trusted-session\/admin\/approve$/, policy: 'requireDashboard' },

  // Agent or dashboard (dual-auth routes — handler branches on principal kind)
  { methods: ['GET'], pattern: /^\/api\/decks$/, policy: 'requireAgentOrDashboard' },
  { methods: ['GET'], pattern: /^\/api\/decks\/[^/]+$/, policy: 'requireAgentOrDashboard' },
  { methods: ['GET'], pattern: /^\/api\/decks\/[^/]+\/services$/, policy: 'requireAgentOrDashboard' },
  { methods: ['POST'], pattern: /^\/api\/decks\/[^/]+\/services$/, policy: 'requireAgentOrDashboard' },
  { methods: ['DELETE'], pattern: /^\/api\/decks\/[^/]+\/services$/, policy: 'requireAgentOrDashboard' },
  { methods: ['PUT'], pattern: /^\/api\/decks\/[^/]+\/services\/reorder$/, policy: 'requireAgentOrDashboard' },
  { methods: ['DELETE'], pattern: /^\/api\/decks\/[^/]+\/services\/clear$/, policy: 'requireAgentOrDashboard' },
  { methods: ['POST'], pattern: /^\/api\/decks\/[^/]+\/credentials$/, policy: 'requireAgentOrDashboard' },
  { methods: ['DELETE'], pattern: /^\/api\/decks\/[^/]+\/credentials$/, policy: 'requireAgentOrDashboard' },
  { methods: ['POST'], pattern: /^\/api\/decks\/[^/]+\/playbooks$/, policy: 'requireAgentOrDashboard' },
  { methods: ['DELETE'], pattern: /^\/api\/decks\/[^/]+\/playbooks$/, policy: 'requireAgentOrDashboard' },
  { methods: ['GET'], pattern: /^\/api\/services$/, policy: 'requireAgentOrDashboard' },
  { methods: ['GET'], pattern: /^\/api\/services\/[^/]+$/, policy: 'requireAgentOrDashboard' },
  { methods: ['GET'], pattern: /^\/api\/services\/[^/]+\/tools$/, policy: 'requireAgentOrDashboard' },
  { methods: ['PUT'], pattern: /^\/api\/services\/[^/]+\/tool-settings$/, policy: 'requireAgentOrDashboard' },
  { methods: ['POST'], pattern: /^\/api\/services\/[^/]+\/call$/, policy: 'requireAgentOrDashboard' },
  { methods: ['GET'], pattern: /^\/api\/credentials$/, policy: 'requireAgentOrDashboard' },
  { methods: ['GET'], pattern: /^\/api\/credentials\/[^/]+$/, policy: 'requireAgentOrDashboard' },
  { methods: ['GET'], pattern: /^\/api\/playbooks\/summaries$/, policy: 'requireAgentOrDashboard' },
  { methods: ['GET'], pattern: /^\/api\/playbooks$/, policy: 'requireAgentOrDashboard' },
  { methods: ['GET'], pattern: /^\/api\/playbooks\/[^/]+$/, policy: 'requireAgentOrDashboard' },
  { methods: ['POST'], pattern: /^\/api\/playbooks$/, policy: 'requireAgentOrDashboard' },
  { methods: ['PUT'], pattern: /^\/api\/playbooks\/[^/]+$/, policy: 'requireAgentOrDashboard' },
  { methods: ['DELETE'], pattern: /^\/api\/playbooks\/[^/]+$/, policy: 'requireAgentOrDashboard' },
  { methods: ['POST'], pattern: /^\/api\/playbook-patches$/, policy: 'requireAgentOrDashboard' },
];

export function shouldApplyHttpPolicy(pathname: string): boolean {
  if (pathname.startsWith('/api/ws/')) {
    return false;
  }
  return pathname === '/health' || pathname === '/' || pathname.startsWith('/api/');
}

export function resolveRoutePolicy(method: string, pathname: string): AuthPolicy | null {
  const upper = method.toUpperCase();
  for (const rule of HTTP_ROUTE_POLICIES) {
    if (rule.methods.includes(upper) && rule.pattern.test(pathname)) {
      return rule.policy;
    }
  }
  return null;
}

export type RegisteredRoute = { method: string; url: string };

export function findUnmatchedRoutes(routes: RegisteredRoute[]): RegisteredRoute[] {
  const unmatched: RegisteredRoute[] = [];
  for (const route of routes) {
    const methods = route.method.split(',').map((m) => m.trim().toUpperCase());
    if (methods.every((method) => method === 'HEAD')) {
      continue;
    }
    const pathname = route.url.split('?')[0];
    if (!shouldApplyHttpPolicy(pathname)) {
      continue;
    }
    const matched = methods
      .filter((method) => method !== 'HEAD')
      .some((method) => resolveRoutePolicy(method, pathname) !== null);
    if (!matched) {
      unmatched.push(route);
    }
  }
  return unmatched;
}
