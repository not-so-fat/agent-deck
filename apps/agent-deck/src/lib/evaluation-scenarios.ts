import type {
  ApiResponse,
  CreateEvaluationScenarioInput,
  EvaluationScenario,
  EvaluationScenarioStatus,
  FeedbackSignal,
  UpdateEvaluationScenarioInput,
} from '@agent-deck/shared';
import { apiRequest } from '@/lib/queryClient';

async function parseApi<T>(response: Response): Promise<T> {
  const body = (await response.json()) as ApiResponse<T>;
  if (!body.success) throw new Error(body.error ?? 'Request failed');
  return body.data as T;
}

export async function listEvaluationScenarios(filters?: {
  targetPlaybookId?: string;
  status?: EvaluationScenarioStatus;
}): Promise<EvaluationScenario[]> {
  const query = new URLSearchParams();
  if (filters?.targetPlaybookId) query.set('targetPlaybookId', filters.targetPlaybookId);
  if (filters?.status) query.set('status', filters.status);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return parseApi(await apiRequest('GET', `/api/evaluation-scenarios${suffix}`));
}

export async function createEvaluationScenario(
  input: CreateEvaluationScenarioInput,
): Promise<EvaluationScenario> {
  return parseApi(await apiRequest('POST', '/api/evaluation-scenarios', input));
}

export async function updateEvaluationScenario(
  id: string,
  input: UpdateEvaluationScenarioInput,
): Promise<EvaluationScenario> {
  return parseApi(await apiRequest('PUT', `/api/evaluation-scenarios/${id}`, input));
}

export type ScenarioSelectionEligibility =
  | { eligible: true; playbookId: string; reason: null }
  | { eligible: false; playbookId: null; reason: string };

export function getScenarioSelectionEligibility(
  signals: FeedbackSignal[],
): ScenarioSelectionEligibility {
  if (signals.length === 0) {
    return { eligible: false, playbookId: null, reason: 'Select feedback rows first.' };
  }
  if (signals.some((signal) => !signal.candidatePlaybookId)) {
    return {
      eligible: false,
      playbookId: null,
      reason: 'Every selected row must have a candidate playbook.',
    };
  }
  const playbookIds = new Set(signals.map((signal) => signal.candidatePlaybookId));
  if (playbookIds.size !== 1) {
    return {
      eligible: false,
      playbookId: null,
      reason: 'Selected rows must belong to the same candidate playbook.',
    };
  }
  return { eligible: true, playbookId: [...playbookIds][0]!, reason: null };
}
