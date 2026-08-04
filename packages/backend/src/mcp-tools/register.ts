import { z } from 'zod';
import { countDeckCards, formatDisplayLine, PatchOpSchema } from '@agent-deck/shared';
import type { StubBindSyncResult } from '../playbooks/stub-sync';
import { resolveDeckBindingSource } from '../mcp-session-binding';
import { executeListCollection, executeManageDeckCard } from './deck-card-ops';
import { McpToolProfile, profileIncludes } from './profile';

type RegisterToolFn = (
  name: string,
  config: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> },
  handler: (...args: any[]) => Promise<any>,
) => void;

export type McpToolHost = {
  registerTool: RegisterToolFn;
  profile: McpToolProfile;
  getSessionId(): string;
  getAgentHeaders(): Record<string, string>;
  getBoundDeckId(): Promise<string>;
  callBackendAPI(endpoint: string, init?: RequestInit): Promise<any>;
  fetchDeck(deckId: string): Promise<{ id: string; name: string }>;
  buildBindingPayload(sessionId: string): Promise<Record<string, unknown>>;
  registerLiveDisplay(sessionId: string): Promise<void>;
  syncWorkspaceOnBind(
    workspaceRoot: string,
    deck: { id: string; name: string },
  ): Promise<StubBindSyncResult | null>;
  sessionBinding: {
    getBinding(sessionId: string): {
      workspaceRoot?: string;
      deckId?: string;
      deckSource?: string;
    };
    setWorkspace(sessionId: string, workspaceRoot: string): void;
    setDeckId(sessionId: string, deckId: string): void;
    hasSessionDeckOverride(sessionId: string): boolean;
  };
  badgeBySession: Map<string, string>;
  backendUrl: string;
  toolResult(data: unknown): { content: Array<{ type: 'text'; text: string }> };
  toolError(error: unknown): { content: Array<{ type: 'text'; text: string }> };
};

const cardTypeSchema = z.enum(['service', 'credential', 'playbook']);

export function registerMcpTools(host: McpToolHost): void {
  registerRuntimeTools(host);
  if (profileIncludes(host.profile, 'editing')) {
    registerEditingTools(host);
  }
  if (profileIncludes(host.profile, 'legacy')) {
    registerLegacyTools(host);
  }
}

function registerRuntimeTools(host: McpToolHost): void {
  const { registerTool: r } = host;

  r('bind_workspace', {
    title: 'Bind Workspace',
    description:
      'Bind this MCP session to a workspace root and deck. deckId accepts a UUID or exact deck name. Use get_decks to list decks.',
    inputSchema: {
      workspaceRoot: z.string(),
      deckId: z.string().min(1),
    },
  }, async ({ workspaceRoot, deckId }) => {
    try {
      const sessionId = host.getSessionId();
      host.sessionBinding.setWorkspace(sessionId, workspaceRoot);
      const deck = await host.fetchDeck(deckId);
      host.sessionBinding.setDeckId(sessionId, deck.id);
      let stubSync: StubBindSyncResult | null = null;
      try {
        stubSync = await host.syncWorkspaceOnBind(workspaceRoot, deck);
      } catch {
        stubSync = null;
      }
      await host.registerLiveDisplay(sessionId);
      const payload = await host.buildBindingPayload(sessionId);
      const response: Record<string, unknown> = {
        ...payload,
        deck_name: deck.name,
        message: 'Session bound to deck.',
      };
      if (stubSync) {
        response.stubs = {
          created: stubSync.stubs.cursor.created + stubSync.stubs.claude.created,
          updated: stubSync.stubs.cursor.updated + stubSync.stubs.claude.updated,
          removed: stubSync.stubs.cursor.removed + stubSync.stubs.claude.removed,
          cursor: stubSync.stubs.cursor,
          claude: stubSync.stubs.claude,
          host_reload_required: stubSync.host_reload_required,
        };
        if (stubSync.manifestPath) {
          response.manifestPath = stubSync.manifestPath;
        }
        if (stubSync.host_reload_required) {
          response.stub_sync_note =
            'Restart the IDE host so skill/rule discovery reloads stub changes.';
        }
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(response, null, 2),
        }],
      };
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('switch_bound_deck', {
    title: 'Switch Bound Deck',
    description:
      'Switch the deck for this MCP session only. Use when multiple agent sessions share the same workspace path.',
    inputSchema: { deckId: z.string().min(1) },
  }, async ({ deckId }) => {
    try {
      const sessionId = host.getSessionId();
      const snapshot = host.sessionBinding.getBinding(sessionId);
      const deck = await host.fetchDeck(deckId);
      host.sessionBinding.setDeckId(sessionId, deck.id);
      const workspaceRoot = snapshot.workspaceRoot;
      let stubSync: StubBindSyncResult | null = null;
      if (workspaceRoot) {
        try {
          stubSync = await host.syncWorkspaceOnBind(workspaceRoot, deck);
        } catch {
          stubSync = null;
        }
      }
      await host.registerLiveDisplay(sessionId);
      const payload = await host.buildBindingPayload(sessionId);
      const response: Record<string, unknown> = {
        ...payload,
        deck_name: deck.name,
        message: 'Session deck switched. Other sessions are unchanged.',
      };
      if (stubSync) {
        response.stubs = {
          created: stubSync.stubs.cursor.created + stubSync.stubs.claude.created,
          updated: stubSync.stubs.cursor.updated + stubSync.stubs.claude.updated,
          removed: stubSync.stubs.cursor.removed + stubSync.stubs.claude.removed,
          host_reload_required: stubSync.host_reload_required,
        };
        if (stubSync.host_reload_required) {
          response.stub_sync_note =
            'Restart the IDE host so skill/rule discovery reloads stub changes.';
        }
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(response, null, 2),
        }],
      };
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('get_session_binding', {
    title: 'Get Session Binding',
    description:
      'Show workspace and effective deck for this MCP session (session override or env default).',
    inputSchema: {},
  }, async () => {
    try {
      const sessionId = host.getSessionId();
      const snapshot = host.sessionBinding.getBinding(sessionId);
      const deck = await host.callBackendAPI('/api/scope/deck');
      const badge = host.badgeBySession.get(sessionId);
      const cardCounts = deck ? countDeckCards(deck) : { mcp: 0, credentials: 0, playbooks: 0 };
      const displaySummary = formatDisplayLine(deck?.name ?? null, cardCounts, { badge });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            workspaceRoot: snapshot.workspaceRoot,
            session_deck_id: snapshot.deckId,
            session_deck_source: snapshot.deckSource,
            effective_deck_id: deck?.id,
            effective_deck_name: deck?.name,
            effective_deck_source: resolveDeckBindingSource(snapshot as Parameters<typeof resolveDeckBindingSource>[0]),
            badge,
            display_summary: displaySummary,
          }, null, 2),
        }],
      };
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('get_decks', {
    title: 'Get Decks',
    description: 'List all decks (metadata only). Use deck id with bind_workspace.',
    inputSchema: {},
  }, async () => {
    try {
      const decks = await host.callBackendAPI('/api/decks');
      return host.toolResult(decks);
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('get_bound_deck', {
    title: 'Get Bound Deck',
    description:
      'Snapshot of the bound deck: services, API key metadata, playbook summaries, and display_summary. Prefer this over separate list_bound_deck_* tools.',
    inputSchema: {},
  }, async () => {
    try {
      const sessionId = host.getSessionId();
      const deck = await host.callBackendAPI('/api/scope/deck');
      const badge = host.badgeBySession.get(sessionId);
      const cardCounts = deck ? countDeckCards(deck) : { mcp: 0, credentials: 0, playbooks: 0 };
      const displaySummary = formatDisplayLine(deck?.name ?? null, cardCounts, { badge });
      return host.toolResult({
        ...deck,
        display_summary: displaySummary,
      });
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('get_playbook', {
    title: 'Get Playbook',
    description: 'Full markdown body, metadata, and dependencies for a playbook on the bound deck',
    inputSchema: { playbook_id: z.string() },
  }, async ({ playbook_id }) => {
    try {
      const playbook = await host.callBackendAPI(`/api/playbooks/${encodeURIComponent(playbook_id)}`);
      return host.toolResult(playbook);
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('update_playbook', {
    title: 'Update Playbook',
    description:
      'Update a playbook on the bound deck when the user explicitly directs a change (already reviewed). For corrections after normal work, use propose_playbook_patch instead.',
    inputSchema: {
      playbook_id: z.string(),
      title: z.string().optional(),
      body: z.string().optional(),
      triggers: z.array(z.string()).optional(),
      exec: z.string().optional(),
      skill: z.string().optional(),
      depends_on_credential_ids: z.array(z.string()).optional(),
      depends_on_service_ids: z.array(z.string()).optional(),
      auto_detect_dependencies: z.boolean().optional(),
    },
  }, async ({ playbook_id, ...args }) => {
    try {
      const playbook = await host.callBackendAPI(
        `/api/playbooks/${encodeURIComponent(playbook_id)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: args.title,
            body: args.body,
            triggers: args.triggers,
            exec: args.exec,
            skill: args.skill,
            dependsOnCredentialIds: args.depends_on_credential_ids,
            dependsOnServiceIds: args.depends_on_service_ids,
            autoDetectDependencies: args.auto_detect_dependencies,
          }),
        },
      );
      return host.toolResult(playbook);
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('propose_playbook_patch', {
    title: 'Propose Playbook Patch',
    description:
      'Default way to improve playbooks from user corrections. Creates a dashboard review proposal (or kind=signal_only to log without proposing). Prefer add_item to Gotchas/Checklist. Use signal_only when not yet generalizable. When revising the same lesson as an open proposal, pass supersedes with those pp_* ids (from get_playbook openPatches). When curating from the Feedback table, pass signal_ids (every consumed id) so rows link to the proposal; they become actioned on accept.',
    inputSchema: {
      kind: z.enum(['create', 'update', 'merge', 'retire', 'signal_only']),
      playbook_id: z.string().optional(),
      ops: z
        .array(PatchOpSchema)
        .optional()
        .describe(
          'Item-level ops: add_item | amend_item | remove_item | set_triggers | rewrite_body. List ops target ## sections and exact bullet lines only.',
        ),
      new_playbook: z
        .object({
          title: z.string(),
          body: z.string().optional(),
          triggers: z.array(z.string()).min(1),
          exec: z.string().optional(),
          skill: z.string().optional(),
        })
        .optional(),
      rationale: z.string(),
      evidence: z
        .object({
          failure_summary: z.string(),
          user_feedback_excerpt: z.string(),
          corrected_output_hint: z.string().optional(),
        })
        .optional(),
      signal_ids: z
        .array(z.string())
        .optional()
        .describe('Open feedback signal ids to link to this patch (actioned when the patch is accepted)'),
      supersedes: z
        .array(z.string())
        .optional()
        .describe(
          'Open proposed patch ids (pp_*) this proposal replaces — same playbook / same lesson. From get_playbook openPatches.',
        ),
    },
  }, async ({ kind, playbook_id, ops, new_playbook, rationale, evidence, signal_ids, supersedes }) => {
    try {
      const deckId = await host.getBoundDeckId();
      const result = await host.callBackendAPI('/api/playbook-patches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-mcp-session-id': host.getSessionId(),
        },
        body: JSON.stringify({
          kind,
          playbook_id,
          ops,
          new_playbook: new_playbook
            ? { ...new_playbook, body: new_playbook.body ?? '', deck_id: deckId }
            : undefined,
          rationale,
          evidence,
          signal_ids,
          supersedes,
        }),
      });
      if (result?.kind === 'signal_only') {
        return host.toolResult({
          kind: 'signal_only',
          signal: result.signal,
          message:
            'Feedback signal logged (no patch). Unreviewed backlog is curated from the dashboard (copy prompt → paste here with signal_ids).',
        });
      }
      const patch = result?.patch ?? result;
      const triggerWarnings = patch?.conflictsJson
        ? JSON.parse(patch.conflictsJson as string)
        : [];
      return host.toolResult({
        ...patch,
        kind: result?.kind ?? patch?.kind,
        // Null when curation submit (signal_ids) — no new signal row.
        signal_id: result?.signal?.id ?? patch?.signal?.id ?? null,
        superseded: result?.superseded ?? patch?.superseded ?? [],
        trigger_warnings: triggerWarnings,
      });
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('list_service_tools', {
    title: 'List Service Tools',
    description: 'List proxied tools for an MCP service on the bound deck',
    inputSchema: { serviceId: z.string() },
  }, async ({ serviceId }) => {
    try {
      const tools = await host.callBackendAPI(`/api/services/${serviceId}/tools`);
      return host.toolResult(tools);
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('call_service_tool', {
    title: 'Call Service Tool',
    description: 'Call a tool on an MCP service from the bound deck',
    inputSchema: {
      serviceId: z.string(),
      toolName: z.string(),
      arguments: z.union([z.record(z.any()), z.string()]).optional(),
    },
  }, async ({ serviceId, toolName, arguments: args = {} }) => {
    try {
      let normalizedArgs: unknown = args;
      if (typeof normalizedArgs === 'string' && normalizedArgs.length > 0) {
        try {
          normalizedArgs = JSON.parse(normalizedArgs);
        } catch (e) {
          return host.toolError(`Invalid JSON in arguments: ${String(e)}`);
        }
      }

      const res = await fetch(`${host.backendUrl}/api/services/${serviceId}/call`, {
        method: 'POST',
        headers: {
          ...host.getAgentHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ toolName, arguments: normalizedArgs ?? {} }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Backend API error ${res.status}: ${text}`);
      }
      const body = (await res.json()) as {
        success?: boolean;
        data?: unknown;
        result?: unknown;
      };
      const data = body?.success ? (body.data ?? body.result ?? body) : body;
      return host.toolResult(data);
    } catch (error) {
      return host.toolError(error);
    }
  });
}

function registerEditingTools(host: McpToolHost): void {
  const { registerTool: r } = host;

  r('manage_deck_card', {
    title: 'Manage Deck Card',
    description:
      'Link, unlink, or reorder a collection card on the bound deck. Card must exist in list_collection. Does not create cards or store API key secrets.',
    inputSchema: {
      action: z.enum(['link', 'unlink', 'reorder']),
      card_type: cardTypeSchema,
      card_id: z.string().optional(),
      position: z.number().optional(),
      ordered_card_ids: z.array(z.string()).optional(),
    },
  }, async (input) => {
    try {
      const result = await executeManageDeckCard(host, input);
      return host.toolResult(result);
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('list_collection', {
    title: 'List Collection',
    description:
      'List cards in My Collection (metadata only). Optional card_type filter: service, credential, or playbook.',
    inputSchema: {
      card_type: cardTypeSchema.optional(),
    },
  }, async (input) => {
    try {
      const result = await executeListCollection(host, input);
      return host.toolResult(result);
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('register_playbook', {
    title: 'Register Playbook',
    description:
      'Create a playbook card, auto-detect dependencies, and link to the bound deck by default',
    inputSchema: {
      title: z.string(),
      body: z.string(),
      triggers: z.array(z.string()).optional(),
      playbook_id: z.string().optional(),
      exec: z.string().optional(),
      skill: z.string().optional(),
      depends_on_credential_ids: z.array(z.string()).optional(),
      depends_on_service_ids: z.array(z.string()).optional(),
      add_to_bound_deck: z.boolean().optional(),
      auto_detect_dependencies: z.boolean().optional(),
    },
  }, async (args) => {
    try {
      const playbook = await host.callBackendAPI('/api/playbooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: args.title,
          body: args.body,
          triggers: args.triggers,
          id: args.playbook_id,
          exec: args.exec,
          skill: args.skill,
          dependsOnCredentialIds: args.depends_on_credential_ids,
          dependsOnServiceIds: args.depends_on_service_ids,
          addToBoundDeck: args.add_to_bound_deck,
          autoDetectDependencies: args.auto_detect_dependencies,
        }),
      });
      return host.toolResult(playbook);
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('register_service', {
    title: 'Register Service',
    description:
      'Register an MCP service in the collection. Links to bound deck by default. OAuth requires dashboard browser flow.',
    inputSchema: {
      name: z.string(),
      type: z.enum(['mcp', 'a2a', 'local-mcp']),
      url: z.string(),
      description: z.string().optional(),
      cardColor: z.string().optional(),
      credentialId: z.string().optional(),
      headers: z.record(z.string()).optional(),
      localCommand: z.string().optional(),
      localArgs: z.array(z.string()).optional(),
      localWorkingDir: z.string().optional(),
      localEnv: z.record(z.string()).optional(),
      add_to_bound_deck: z.boolean().optional(),
      position: z.number().optional(),
    },
  }, async (args) => {
    try {
      const { add_to_bound_deck, position, ...serviceInput } = args;
      const service = await host.callBackendAPI('/api/services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(serviceInput),
      });

      if (add_to_bound_deck !== false) {
        await executeManageDeckCard(host, {
          action: 'link',
          card_type: 'service',
          card_id: service.id,
          position,
        });
      }

      return host.toolResult(service);
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('update_service', {
    title: 'Update Service',
    description: 'Update MCP service metadata (not OAuth tokens — use dashboard for OAuth)',
    inputSchema: {
      service_id: z.string(),
      name: z.string().optional(),
      type: z.enum(['mcp', 'a2a', 'local-mcp']).optional(),
      url: z.string().optional(),
      description: z.string().optional(),
      cardColor: z.string().optional(),
      credentialId: z.string().optional(),
      headers: z.record(z.string()).optional(),
      localCommand: z.string().optional(),
      localArgs: z.array(z.string()).optional(),
      localWorkingDir: z.string().optional(),
      localEnv: z.record(z.string()).optional(),
    },
  }, async ({ service_id, ...updates }) => {
    try {
      const service = await host.callBackendAPI(`/api/services/${service_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      return host.toolResult(service);
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('update_service_tool_settings', {
    title: 'Update Service Tool Settings',
    description: 'Enable or disable individual proxied tools for a service on the bound deck',
    inputSchema: {
      service_id: z.string(),
      disabled_tools: z.array(z.string()),
    },
  }, async ({ service_id, disabled_tools }) => {
    try {
      const service = await host.callBackendAPI(`/api/services/${service_id}/tool-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabledTools: disabled_tools }),
      });
      return host.toolResult(service);
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('create_deck', {
    title: 'Create Deck',
    description: 'Create a new deck, then bind_workspace to use it',
    inputSchema: {
      name: z.string(),
    },
  }, async ({ name }) => {
    try {
      const deck = await host.callBackendAPI('/api/decks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      return host.toolResult(deck);
    } catch (error) {
      return host.toolError(error);
    }
  });
}

function registerLegacyTools(host: McpToolHost): void {
  const { registerTool: r } = host;

  const boundDeckListHandler = async (segment: 'services' | 'credentials' | 'playbooks') => {
    const deck = await host.callBackendAPI('/api/scope/deck');
    if (segment === 'services') {
      return host.toolResult(deck?.services ?? []);
    }
    if (segment === 'credentials') {
      const credentials = await host.callBackendAPI('/api/credentials');
      return host.toolResult(credentials);
    }
    const playbooks = await host.callBackendAPI('/api/playbooks/summaries');
    return host.toolResult(playbooks);
  };

  r('get_active_deck', {
    title: 'Get Active Deck (deprecated)',
    description: 'Deprecated — use get_bound_deck',
    inputSchema: {},
  }, async () => {
    try {
      const deck = await host.callBackendAPI('/api/scope/deck');
      return host.toolResult(deck);
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('list_bound_deck_services', {
    title: 'List Bound Deck Services (deprecated)',
    description: 'Deprecated — use get_bound_deck',
    inputSchema: {},
  }, async () => {
    try {
      return boundDeckListHandler('services');
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('list_active_deck_services', {
    title: 'List Active Deck Services (deprecated)',
    description: 'Deprecated — use get_bound_deck',
    inputSchema: {},
  }, async () => {
    try {
      return boundDeckListHandler('services');
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('list_bound_deck_credentials', {
    title: 'List Bound Deck Credentials (deprecated)',
    description: 'Deprecated — use get_bound_deck',
    inputSchema: {},
  }, async () => {
    try {
      return boundDeckListHandler('credentials');
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('list_active_deck_credentials', {
    title: 'List Active Deck Credentials (deprecated)',
    description: 'Deprecated — use get_bound_deck',
    inputSchema: {},
  }, async () => {
    try {
      return boundDeckListHandler('credentials');
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('list_playbooks', {
    title: 'List Playbooks (deprecated)',
    description: 'Deprecated — use get_bound_deck for summaries or get_playbook for full body',
    inputSchema: {},
  }, async () => {
    try {
      return boundDeckListHandler('playbooks');
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('list_collection_services', {
    title: 'List Collection Services (deprecated)',
    description: 'Deprecated — use list_collection',
    inputSchema: {},
  }, async () => {
    try {
      const services = await host.callBackendAPI('/api/services');
      return host.toolResult(services);
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('list_collection_credentials', {
    title: 'List Collection Credentials (deprecated)',
    description: 'Deprecated — use list_collection',
    inputSchema: {},
  }, async () => {
    try {
      const credentials = await host.callBackendAPI('/api/credentials/collection');
      return host.toolResult(credentials);
    } catch (error) {
      return host.toolError(error);
    }
  });

  r('list_collection_playbooks', {
    title: 'List Collection Playbooks (deprecated)',
    description: 'Deprecated — use list_collection',
    inputSchema: {},
  }, async () => {
    try {
      const playbooks = await host.callBackendAPI('/api/playbooks/collection');
      return host.toolResult(playbooks);
    } catch (error) {
      return host.toolError(error);
    }
  });

  const legacyLink = (
    name: string,
    title: string,
    cardType: 'service' | 'credential' | 'playbook',
    idField: 'service_id' | 'credential_id' | 'playbook_id',
  ) => {
    r(name, {
      title,
      description: 'Deprecated — use manage_deck_card',
      inputSchema: {
        [idField]: z.string(),
        position: z.number().optional(),
      },
    }, async (args: Record<string, unknown>) => {
      try {
        const result = await executeManageDeckCard(host, {
          action: 'link',
          card_type: cardType,
          card_id: String(args[idField]),
          position: args.position as number | undefined,
        });
        return host.toolResult({ ...result, [idField]: args[idField] });
      } catch (error) {
        return host.toolError(error);
      }
    });
  };

  const legacyUnlink = (
    name: string,
    title: string,
    cardType: 'service' | 'credential' | 'playbook',
    idField: 'service_id' | 'credential_id' | 'playbook_id',
  ) => {
    r(name, {
      title,
      description: 'Deprecated — use manage_deck_card',
      inputSchema: { [idField]: z.string() },
    }, async (args: Record<string, unknown>) => {
      try {
        const result = await executeManageDeckCard(host, {
          action: 'unlink',
          card_type: cardType,
          card_id: String(args[idField]),
        });
        return host.toolResult({ ...result, [idField]: args[idField] });
      } catch (error) {
        return host.toolError(error);
      }
    });
  };

  legacyLink('add_service_to_bound_deck', 'Add Service To Bound Deck (deprecated)', 'service', 'service_id');
  legacyUnlink('remove_service_from_bound_deck', 'Remove Service From Bound Deck (deprecated)', 'service', 'service_id');
  legacyLink('add_credential_to_bound_deck', 'Add Credential To Bound Deck (deprecated)', 'credential', 'credential_id');
  legacyUnlink('remove_credential_from_bound_deck', 'Remove Credential From Bound Deck (deprecated)', 'credential', 'credential_id');
  legacyLink('add_playbook_to_bound_deck', 'Add Playbook To Bound Deck (deprecated)', 'playbook', 'playbook_id');
  legacyUnlink('remove_playbook_from_bound_deck', 'Remove Playbook From Bound Deck (deprecated)', 'playbook', 'playbook_id');
}

export function listToolNamesForProfile(profile: McpToolProfile): string[] {
  const names: string[] = [];
  const collector: RegisterToolFn = (name) => {
    names.push(name);
  };
  const stubHost = {
    registerTool: collector,
    profile,
    getSessionId: () => 'stub',
    getAgentHeaders: () => ({}),
    getBoundDeckId: async () => 'deck',
    callBackendAPI: async () => ({}),
    fetchDeck: async () => ({ id: 'deck', name: 'stub' }),
    buildBindingPayload: async () => ({}),
    registerLiveDisplay: async () => {},
    syncWorkspaceOnBind: async () => null,
    sessionBinding: {
      getBinding: () => ({}),
      setWorkspace: () => {},
      setDeckId: () => {},
      hasSessionDeckOverride: () => false,
    },
    badgeBySession: new Map(),
    backendUrl: 'http://127.0.0.1:1',
    toolResult: (data: unknown) => ({ content: [{ type: 'text' as const, text: String(data) }] }),
    toolError: (error: unknown) => ({ content: [{ type: 'text' as const, text: String(error) }] }),
  };
  registerMcpTools(stubHost);
  return names;
}
