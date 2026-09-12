import { readCliBackendPort } from './defaults';
import { readAdminSecret } from './admin-secret';
import { formatTrustedWriterError } from './grant-issue';

type TrustedWriterAuth =
  | { ok: true; authorization: string }
  | { ok: false; error: string };

function resolveBackendUrl(host?: string): string {
  return `http://${host ?? process.env.AGENT_DECK_HOST ?? '127.0.0.1'}:${readCliBackendPort()}`;
}

async function trustedWriterAuth(): Promise<TrustedWriterAuth> {
  const adminSecret = await readAdminSecret();
  if (!adminSecret) {
    return {
      ok: false,
      error:
        'No admin secret — run `agent-deck setup` or `agent-deck start` once to initialize ~/.agent-deck/admin-secret',
    };
  }
  return { ok: true, authorization: `Bearer ${adminSecret}` };
}

async function readJson(response: Response): Promise<{
  ok?: boolean;
  success?: boolean;
  error?: string;
  message?: string;
  error_code?: string;
  data?: unknown;
} | null> {
  try {
    return (await response.json()) as {
      ok?: boolean;
      success?: boolean;
      error?: string;
      message?: string;
      error_code?: string;
      data?: unknown;
    };
  } catch {
    return null;
  }
}

export async function runCoordinatorCommand(argv: string[]): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === 'help' || action === '--help' || action === '-h') {
    printCoordinatorUsage();
    return action ? 0 : 1;
  }

  switch (action) {
    case 'enroll':
      return enroll(rest);
    case 'status':
      return status(rest);
    case 'revoke':
      return revoke(rest);
    default:
      console.error(`Unknown coordinator action: ${action}`);
      printCoordinatorUsage();
      return 1;
  }
}

function printCoordinatorUsage(): void {
  console.log(`Usage:
  agent-deck coordinator enroll --coordinator-id <id> --deck <deckId> [--deck <deckId>...]
  agent-deck coordinator status --enrollment-id <enr_…>
  agent-deck coordinator revoke --enrollment-id <enr_…>

Enrolls a local Agent Dealer coordinator to mint short-lived execution authority (NOT-86).
Dashboard UX is deferred (NOT-90). OS launcher secret delivery is deferred (NOT-89).
`);
}

function parseFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function parseRepeatFlag(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && i + 1 < args.length) {
      values.push(args[i + 1]);
      i += 1;
    }
  }
  return values;
}

async function enroll(args: string[]): Promise<number> {
  const coordinatorId = parseFlag(args, '--coordinator-id');
  const decks = parseRepeatFlag(args, '--deck');
  if (!coordinatorId || decks.length === 0) {
    console.error('Required: --coordinator-id <id> and at least one --deck <deckId>');
    return 1;
  }

  const auth = await trustedWriterAuth();
  if (!auth.ok) {
    console.error(auth.error);
    return 1;
  }

  const response = await fetch(`${resolveBackendUrl()}/api/execution-authority/enrollments`, {
    method: 'POST',
    headers: {
      Authorization: auth.authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ coordinatorId, allowedDeckIds: decks }),
  });
  const payload = await readJson(response);
  if (!response.ok || !payload?.ok || !payload.data) {
    console.error(
      formatTrustedWriterError(response.status, payload, 'Failed to enroll coordinator'),
    );
    return 1;
  }

  const data = payload.data as {
    enrollment: {
      enrollmentId: string;
      coordinatorId: string;
      status: string;
      allowedDeckIds: string[];
    };
    enrollmentSecret: string;
  };

  console.log(`Enrolled coordinator ${data.enrollment.coordinatorId}`);
  console.log(`enrollmentId: ${data.enrollment.enrollmentId}`);
  console.log(`status: ${data.enrollment.status}`);
  console.log(`allowedDeckIds: ${data.enrollment.allowedDeckIds.join(', ')}`);
  console.log('');
  console.log('Store this enrollment secret for Dealer mint calls (shown once):');
  console.log(`enrollmentSecret: ${data.enrollmentSecret}`);
  console.log(`Bearer token form: ${data.enrollment.enrollmentId}:${data.enrollmentSecret}`);
  return 0;
}

async function status(args: string[]): Promise<number> {
  const enrollmentId = parseFlag(args, '--enrollment-id');
  if (!enrollmentId) {
    console.error('Required: --enrollment-id <enr_…>');
    return 1;
  }

  const auth = await trustedWriterAuth();
  if (!auth.ok) {
    console.error(auth.error);
    return 1;
  }

  const response = await fetch(
    `${resolveBackendUrl()}/api/execution-authority/enrollments/${encodeURIComponent(enrollmentId)}`,
    { headers: { Authorization: auth.authorization } },
  );
  const payload = await readJson(response);
  if (!response.ok || !payload?.ok || !payload.data) {
    console.error(formatTrustedWriterError(response.status, payload, 'Failed to load enrollment'));
    return 1;
  }

  const enrollment = payload.data as {
    enrollmentId: string;
    coordinatorId: string;
    status: string;
    allowedDeckIds: string[];
    createdAt: string;
    revokedAt: string | null;
  };
  console.log(JSON.stringify(enrollment, null, 2));
  return 0;
}

async function revoke(args: string[]): Promise<number> {
  const enrollmentId = parseFlag(args, '--enrollment-id');
  if (!enrollmentId) {
    console.error('Required: --enrollment-id <enr_…>');
    return 1;
  }

  const auth = await trustedWriterAuth();
  if (!auth.ok) {
    console.error(auth.error);
    return 1;
  }

  const response = await fetch(
    `${resolveBackendUrl()}/api/execution-authority/enrollments/${encodeURIComponent(enrollmentId)}/revoke`,
    {
      method: 'POST',
      headers: { Authorization: auth.authorization },
    },
  );
  const payload = await readJson(response);
  if (!response.ok || !payload?.ok) {
    console.error(formatTrustedWriterError(response.status, payload, 'Failed to revoke enrollment'));
    return 1;
  }

  console.log(`Revoked enrollment ${enrollmentId}`);
  return 0;
}
