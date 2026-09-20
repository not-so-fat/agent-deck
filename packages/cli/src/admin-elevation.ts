import { openDashboardInBrowser, shouldOpenDashboardByDefault } from './dashboard-open';

type ToolResult = {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
};

export type AdminElevationApproval = {
  approvalPath: string;
  challengeId: string;
  runtimeSessionId: string;
  expiresAt?: string;
};

/** Read and validate the approval target returned by request_admin_elevation. */
export function readAdminElevationApproval(result: unknown): AdminElevationApproval | undefined {
  const toolResult = result as ToolResult | undefined;
  if (!toolResult || toolResult.isError || !Array.isArray(toolResult.content)) {
    return undefined;
  }

  for (const item of toolResult.content) {
    if (item?.type !== 'text' || typeof item.text !== 'string') {
      continue;
    }
    try {
      const data = JSON.parse(item.text) as Record<string, unknown>;
      const approvalPath = typeof data.approvalUrl === 'string' ? data.approvalUrl : '';
      if (!approvalPath.startsWith('/')) {
        continue;
      }
      const url = new URL(approvalPath, 'http://agent-deck.local');
      if (url.origin !== 'http://agent-deck.local' || url.pathname !== '/admin/approve') {
        continue;
      }

      const challengeId = url.searchParams.get('challenge') ?? '';
      const runtimeSessionId = url.searchParams.get('session') ?? '';
      if (!challengeId || !runtimeSessionId) {
        continue;
      }
      if (typeof data.challengeId === 'string' && data.challengeId !== challengeId) {
        continue;
      }
      if (typeof data.runtimeSessionId === 'string' && data.runtimeSessionId !== runtimeSessionId) {
        continue;
      }

      return {
        approvalPath,
        challengeId,
        runtimeSessionId,
        ...(typeof data.expiresAt === 'string' ? { expiresAt: data.expiresAt } : {}),
      };
    } catch {
      // Other text content is not an elevation response.
    }
  }
  return undefined;
}

/** Mint an authenticated dashboard URL and open the exact challenge/session pair. */
export async function openAdminElevationApproval(
  backendUrl: string,
  result: unknown,
  opener = openDashboardInBrowser,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // AGENT_DECK_NO_OPEN is an explicit opt-out; the tool result still carries the URL.
  if (!shouldOpenDashboardByDefault(env)) {
    return;
  }
  const approval = readAdminElevationApproval(result);
  if (!approval) {
    throw new Error('elevation response did not contain a valid approval URL');
  }
  const opened = await opener(backendUrl, approval.approvalPath);
  if (opened.code !== 0) {
    throw new Error(opened.message ?? 'failed to open elevation approval');
  }
}
