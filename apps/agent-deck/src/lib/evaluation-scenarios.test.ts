import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackSignal } from '@agent-deck/shared';
import {
  getScenarioSelectionEligibility,
  listEvaluationScenarios,
  updateEvaluationScenario,
} from './evaluation-scenarios';

const signal = (id: string, candidatePlaybookId: string | null): FeedbackSignal => ({
  id,
  source: 'ide',
  sourceRef: null,
  failureSummary: 'Missed blocker',
  userFeedbackExcerpt: 'Find the blocker',
  correctedOutputHint: null,
  candidatePlaybookId,
  candidateDeckId: null,
  linkedPatchId: null,
  status: 'open',
  createdAt: '2026-10-29T00:00:00.000Z',
});

describe('evaluation scenario client', () => {
  beforeEach(() => vi.mocked(fetch).mockReset());

  it('accepts one non-null playbook and explains mixed or unmapped selections', () => {
    expect(getScenarioSelectionEligibility([signal('fs_one', 'pb_review'), signal('fs_two', 'pb_review')])).toEqual({
      eligible: true,
      playbookId: 'pb_review',
      reason: null,
    });
    expect(getScenarioSelectionEligibility([signal('fs_one', 'pb_review'), signal('fs_two', 'pb_other')])).toMatchObject({
      eligible: false,
      reason: expect.stringContaining('same candidate playbook'),
    });
    expect(getScenarioSelectionEligibility([signal('fs_one', null)])).toMatchObject({
      eligible: false,
      reason: expect.stringContaining('must have a candidate playbook'),
    });
  });

  it('sends list filters and status transitions to the scenario API', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await listEvaluationScenarios({ targetPlaybookId: 'pb_review', status: 'ready' });
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/evaluation-scenarios?targetPlaybookId=pb_review&status=ready', expect.objectContaining({ method: 'GET' }));
    await updateEvaluationScenario('es_review', { status: 'retired' });
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/evaluation-scenarios/es_review', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ status: 'retired' }) }));
  });
});
