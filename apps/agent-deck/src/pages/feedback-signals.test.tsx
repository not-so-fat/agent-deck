import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getQueryFn } from '@/lib/queryClient';
import FeedbackSignalsPage from './feedback-signals';

const signals = [
  ['fs_first', 'pb_review', 'First excerpt'],
  ['fs_second', 'pb_review', 'Second excerpt'],
  ['fs_mixed', 'pb_other', 'Mixed excerpt'],
  ['fs_unmapped', null, 'Unmapped excerpt'],
].map(([id, candidatePlaybookId, excerpt]) => ({
  id,
  source: 'ide',
  sourceRef: null,
  failureSummary: `Failure for ${id}`,
  userFeedbackExcerpt: excerpt,
  correctedOutputHint: null,
  candidatePlaybookId,
  candidateDeckId: null,
  linkedPatchId: null,
  status: 'open',
  createdAt: '2026-10-29T00:00:00.000Z',
}));

const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status, headers: { 'Content-Type': 'application/json' } });
const rejected = (message: string) => new Response(JSON.stringify({ success: false, error: message }), { status: 400, headers: { 'Content-Type': 'application/json' } });

const scenarioRows = [
  {
    id: 'es_draft', targetPlaybookId: 'pb_review', name: 'Draft case', description: 'Draft description',
    taskInput: '', historicalFailedOutput: null, expectations: [], sourceSignalIds: ['fs_first'],
    status: 'draft', createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z',
  },
  {
    id: 'es_ready', targetPlaybookId: 'pb_review', name: 'Ready case', description: 'Ready description',
    taskInput: 'Review it', historicalFailedOutput: 'Looks good',
    expectations: [{ id: 'blocker', type: 'contains', value: 'blocking' }], sourceSignalIds: ['fs_first', 'fs_second'],
    status: 'ready', createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z',
  },
];

function renderPage(readyError?: string, listedScenarios: typeof scenarioRows = []) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (input === undefined) return ok({});
    const url = String(input);
    if (url === '/api/playbooks/vault') return ok([{ id: 'pb_review', title: 'Review PR' }, { id: 'pb_other', title: 'Other' }]);
    if (url.startsWith('/api/feedback-signals')) return ok(signals);
    if (url.startsWith('/api/evaluation-scenarios') && init?.method === 'GET') return ok(listedScenarios);
    if (url === '/api/evaluation-scenarios' && init?.method === 'POST') {
      if (readyError) return rejected(readyError);
      return ok({
        id: 'es_created',
        ...JSON.parse(String(init.body)),
        createdAt: '2026-10-29T00:00:00.000Z',
        updatedAt: '2026-10-29T00:00:00.000Z',
      }, 201);
    }
    if (url.startsWith('/api/evaluation-scenarios/') && init?.method === 'PUT') {
      const existing = listedScenarios.find((scenario) => url.endsWith(scenario.id))!;
      const update = JSON.parse(String(init.body));
      return ok({ ...existing, ...update });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { queryFn: getQueryFn({ on401: 'throw' }), retry: false }, mutations: { retry: false } } });
  const { hook } = memoryLocation({ path: '/feedback-signals' });
  return render(<Router hook={hook}><QueryClientProvider client={client}><FeedbackSignalsPage /></QueryClientProvider></Router>);
}

async function select(...ids: string[]) {
  for (const id of ids) fireEvent.click(await screen.findByRole('checkbox', { name: `Select ${id}` }));
}

describe('Feedback scenario curation', () => {
  const writeText = vi.fn();
  beforeEach(() => {
    vi.mocked(fetch).mockReset();
    writeText.mockReset();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });

  it('opens fixed same-playbook sources and disables mixed or unmapped selections with reasons', async () => {
    renderPage();
    await select('fs_first', 'fs_second');
    const create = screen.getByRole('button', { name: 'Create scenario' });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    expect(await screen.findByLabelText('Scenario editor')).toHaveTextContent('pb_review');
    expect(screen.getByLabelText('Scenario editor')).toHaveTextContent('fs_first, fs_second');
    fireEvent.click(screen.getByRole('button', { name: 'Close scenario editor' }));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select fs_second' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select fs_mixed' }));
    expect(create).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('same candidate playbook');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select fs_first' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select fs_mixed' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select fs_unmapped' }));
    expect(create).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('must have a candidate playbook');
  });

  it.each([
    'Ready scenarios require task input',
    'Ready scenarios require a historical failed output',
    'Ready scenarios require at least one source signal',
    'Ready scenarios require at least one deterministic expectation',
  ])('shows the ready API error: %s', async (message) => {
    renderPage(message);
    await select('fs_first', 'fs_second');
    fireEvent.click(screen.getByRole('button', { name: 'Create scenario' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Blocking review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/evaluation-scenarios', expect.objectContaining({ method: 'POST' })));
  });

  it('saves an incomplete draft with fixed source evidence', async () => {
    renderPage();
    await select('fs_first', 'fs_second');
    fireEvent.click(screen.getByRole('button', { name: 'Create scenario' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Incomplete review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      const post = vi.mocked(fetch).mock.calls.find(([url, init]) => url === '/api/evaluation-scenarios' && init?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse(String(post![1]?.body))).toMatchObject({
        name: 'Incomplete review',
        taskInput: '',
        historicalFailedOutput: null,
        expectations: [],
        sourceSignalIds: ['fs_first', 'fs_second'],
        status: 'draft',
      });
    });
  });

  it('filters and edits scenarios, transitions status, and copies exact ready case JSON', async () => {
    renderPage(undefined, scenarioRows);
    fireEvent.click(screen.getByRole('button', { name: 'Scenarios' }));
    expect(await screen.findByText('Draft case')).toBeInTheDocument();
    expect(screen.getByText('Ready case')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Scenario playbook filter'), { target: { value: 'pb_review' } });
    fireEvent.change(screen.getByLabelText('Scenario status filter'), { target: { value: 'ready' } });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/evaluation-scenarios?targetPlaybookId=pb_review&status=ready', expect.objectContaining({ method: 'GET' })));

    const draftCard = (await screen.findByText('Draft case')).closest('article')!;
    fireEvent.click(draftCard.querySelector('button')!);
    expect(await screen.findByLabelText('Scenario editor')).toHaveTextContent('First excerpt');
    fireEvent.click(screen.getByRole('button', { name: 'Close scenario editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/evaluation-scenarios/es_draft', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ status: 'ready' }) })));

    fireEvent.click(screen.getByRole('button', { name: 'Copy case JSON' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual({
      id: 'es_ready',
      description: 'Ready description',
      sourceSignalIds: ['fs_first', 'fs_second'],
      expectations: [{ id: 'blocker', type: 'contains', value: 'blocking' }],
    });
  });
});
