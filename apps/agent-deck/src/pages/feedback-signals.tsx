import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { evaluationScenarioToExperimentCase, type CreateEvaluationScenarioInput, type EvaluationScenario, type EvaluationScenarioStatus, type FeedbackSignal, type Playbook } from '@agent-deck/shared';
import { buildCurationPromptForAgent, discardFeedbackSignals, listFeedbackSignals, signalLooksInProposal } from '@/lib/feedback-signals';
import { createEvaluationScenario, getScenarioSelectionEligibility, listEvaluationScenarios, updateEvaluationScenario } from '@/lib/evaluation-scenarios';
import { ScenarioEditor, type ScenarioEditorValue } from '@/components/scenario-editor';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Copy, FlaskConical, Pencil, Trash2 } from 'lucide-react';

const CHECKBOX_CLASS = 'border-[#C4B643] data-[state=checked]:bg-[#C4B643] data-[state=checked]:text-[#0A0A07] data-[state=indeterminate]:bg-[#C4B643] data-[state=indeterminate]:text-[#0A0A07]';
type FeedbackStatus = 'open' | 'actioned' | 'discarded' | 'all';
type View = 'feedback' | 'scenarios';

export default function FeedbackSignalsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>('feedback');
  const [statusFilter, setStatusFilter] = useState<FeedbackStatus>('open');
  const [playbookId, setPlaybookId] = useState('');
  const [includeInProposal, setIncludeInProposal] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<
    | { kind: 'create'; playbookId: string; signalIds: string[] }
    | { kind: 'edit'; scenario: EvaluationScenario }
    | null
  >(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [scenarioPlaybookId, setScenarioPlaybookId] = useState('');
  const [scenarioStatus, setScenarioStatus] = useState<EvaluationScenarioStatus | 'all'>('all');

  const { data: playbooksResponse } = useQuery<{ success: boolean; data: Playbook[] }>({ queryKey: ['/api/playbooks/vault'] });
  const playbooks = playbooksResponse?.data ?? [];
  const titleById = useMemo(() => new Map(playbooks.map((p) => [p.id, p.title])), [playbooks]);
  const listFilters = { status: statusFilter === 'all' ? undefined : statusFilter, playbookId: playbookId || undefined, excludeInProposal: statusFilter === 'open' ? !includeInProposal : undefined };
  const { data: signals = [], isLoading } = useQuery({ queryKey: ['/api/feedback-signals', listFilters], queryFn: () => listFeedbackSignals(listFilters) });
  const { data: allSignals = [] } = useQuery({ queryKey: ['/api/feedback-signals', { allForScenarios: true }], queryFn: () => listFeedbackSignals(), enabled: view === 'scenarios' || editor?.kind === 'edit' });
  const scenarioFilters = { targetPlaybookId: scenarioPlaybookId || undefined, status: scenarioStatus === 'all' ? undefined : scenarioStatus };
  const { data: scenarios = [], isLoading: scenariosLoading } = useQuery({ queryKey: ['/api/evaluation-scenarios', scenarioFilters], queryFn: () => listEvaluationScenarios(scenarioFilters), enabled: view === 'scenarios' });

  const invalidateScenarios = () => queryClient.invalidateQueries({ queryKey: ['/api/evaluation-scenarios'] });
  const saveMutation = useMutation({
    mutationFn: async ({ value, status }: { value: ScenarioEditorValue; status: EvaluationScenarioStatus }) => {
      if (!editor) throw new Error('Scenario editor is closed');
      if (editor.kind === 'create') {
        return createEvaluationScenario({ targetPlaybookId: editor.playbookId, sourceSignalIds: editor.signalIds, ...value, status } satisfies CreateEvaluationScenarioInput);
      }
      return updateEvaluationScenario(editor.scenario.id, { ...value, targetPlaybookId: editor.scenario.targetPlaybookId, sourceSignalIds: editor.scenario.sourceSignalIds, status });
    },
    onSuccess: (scenario) => { setEditorError(null); setEditor({ kind: 'edit', scenario }); void invalidateScenarios(); toast({ title: scenario.status === 'ready' ? 'Scenario ready' : 'Draft saved' }); },
    onError: (error: Error) => setEditorError(error.message),
  });
  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: EvaluationScenarioStatus }) => updateEvaluationScenario(id, { status }),
    onSuccess: (scenario) => { void invalidateScenarios(); toast({ title: `Scenario ${scenario.status}` }); },
    onError: (error: Error) => toast({ title: 'Status change rejected', description: error.message, variant: 'destructive' }),
  });
  const discardMutation = useMutation({
    mutationFn: discardFeedbackSignals,
    onSuccess: (result) => { toast({ title: `Discarded ${result.discarded} signal(s)` }); setSelected(new Set()); void queryClient.invalidateQueries({ queryKey: ['/api/feedback-signals'] }); },
    onError: (error: Error) => toast({ title: 'Discard failed', description: error.message, variant: 'destructive' }),
  });

  const selectedSignals = signals.filter((s) => selected.has(s.id));
  const eligibility = getScenarioSelectionEligibility(selectedSignals);
  const openSelected = selectedSignals.filter((s) => s.status === 'open').map((s) => s.id);
  const allVisibleSelected = signals.length > 0 && signals.every((s) => selected.has(s.id));
  const someVisibleSelected = signals.some((s) => selected.has(s.id));
  const editorScenario = editor?.kind === 'edit' ? editor.scenario : null;
  const editorPlaybookId = editor?.kind === 'create' ? editor.playbookId : editorScenario?.targetPlaybookId;
  const editorSignalIds = editor?.kind === 'create' ? editor.signalIds : editorScenario?.sourceSignalIds;
  const editorSignals = (editor?.kind === 'create' ? signals : allSignals).filter((s) => editorSignalIds?.includes(s.id));

  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const copyForAgent = async () => {
    const chosen = selected.size > 0 ? selectedSignals : signals;
    if (chosen.length === 0) return;
    try { await navigator.clipboard.writeText(buildCurationPromptForAgent(chosen)); toast({ title: 'Copied curation prompt', description: `${chosen.length} signal id(s) included.` }); }
    catch (error) { toast({ title: 'Copy failed', description: error instanceof Error ? error.message : 'Clipboard unavailable', variant: 'destructive' }); }
  };
  const copyCase = async (scenario: EvaluationScenario) => {
    try { await navigator.clipboard.writeText(JSON.stringify(evaluationScenarioToExperimentCase(scenario), null, 2)); toast({ title: 'Copied evaluator case JSON' }); }
    catch (error) { toast({ title: 'Copy failed', description: error instanceof Error ? error.message : 'Clipboard unavailable', variant: 'destructive' }); }
  };
  const openEditor = (scenario: EvaluationScenario) => { setEditorError(null); setEditor({ kind: 'edit', scenario }); };

  return <div className="flex min-h-dvh flex-col bg-gray-950 text-gray-100">
    <header className="shrink-0 border-b border-gray-800 px-4 py-4 sm:px-6"><div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3">
      <Link href="/"><Button variant="ghost" size="sm" className="text-gray-300"><ArrowLeft className="mr-1 h-4 w-4" />Home</Button></Link>
      <h1 className="font-ui-display text-lg font-semibold">Feedback</h1>
      <Button size="sm" variant={view === 'feedback' ? 'gold' : 'ghost'} onClick={() => setView('feedback')}>Signals</Button>
      <Button size="sm" variant={view === 'scenarios' ? 'gold' : 'ghost'} onClick={() => setView('scenarios')}>Scenarios</Button>
      <Link href="/playbook-patches" className="ml-auto text-sm hover:underline" style={{ color: '#92E4DD' }}>Playbook proposals →</Link>
    </div></header>

    <main className="mx-auto w-full max-w-7xl flex-1 space-y-4 px-4 py-6 sm:px-6">
      {view === 'feedback' ? <>
        <p className="text-sm text-gray-400">Review correction signals or curate same-playbook rows into deterministic evaluation scenarios.</p>
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-800 bg-gray-900/40 p-3">
          <label className="text-xs text-gray-500">
            <span className="font-ui-display">Playbook</span>
            <select
              className="mt-1 block min-w-[12rem] rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-100"
              value={playbookId}
              onChange={(e) => { setPlaybookId(e.target.value); setSelected(new Set()); }}
            >
              <option value="">All</option>
              {playbooks.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap gap-1">{([['open', 'Open'], ['actioned', 'Actioned'], ['discarded', 'Discarded'], ['all', 'All']] as const).map(([value, label]) => <Button key={value} size="sm" variant={statusFilter === value ? 'gold' : 'outline'} aria-pressed={statusFilter === value} onClick={() => { setStatusFilter(value); setSelected(new Set()); }}>{label}</Button>)}</div>
          {statusFilter === 'open' && <label className="flex items-center gap-2 text-xs text-gray-400"><input type="checkbox" checked={includeInProposal} onChange={(e) => setIncludeInProposal(e.target.checked)} />Include already in an open proposal</label>}
          <div className="ml-auto flex flex-wrap items-start gap-2">
            <div className="flex flex-col items-end"><Button size="sm" variant="gold" disabled={!eligibility.eligible} onClick={() => { if (eligibility.eligible) { setEditorError(null); setEditor({ kind: 'create', playbookId: eligibility.playbookId, signalIds: selectedSignals.map((s) => s.id) }); } }}><FlaskConical className="mr-1 h-3.5 w-3.5" />Create scenario</Button>{!eligibility.eligible && selected.size > 0 && <p role="status" className="mt-1 max-w-xs text-right text-xs text-amber-300">{eligibility.reason}</p>}</div>
            <Button size="sm" variant="outline" disabled={signals.length === 0} onClick={() => void copyForAgent()}>
              <Copy className="mr-1 h-3.5 w-3.5" />
              <span className="font-ui-display">Copy for agent</span>
              {selected.size > 0 ? ` (${selected.size})` : ''}
            </Button>
            <Button size="sm" variant="destructive" disabled={openSelected.length === 0 || discardMutation.isPending} onClick={() => discardMutation.mutate(openSelected)}><Trash2 className="mr-1 h-3.5 w-3.5" />Discard selected</Button>
          </div>
        </div>
        {editor && editorPlaybookId && <ScenarioEditor scenario={editorScenario} playbookId={editorPlaybookId} playbookTitle={titleById.get(editorPlaybookId) ?? editorPlaybookId} sourceSignals={editorSignals} error={editorError} busy={saveMutation.isPending} onCancel={() => { setEditor(null); setEditorError(null); }} onSave={(value, status) => saveMutation.mutate({ value, status })} />}
        {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
        {!isLoading && signals.length === 0 && <p className="text-sm text-gray-500">No signals match these filters.</p>}
        {!isLoading && signals.length > 0 && <FeedbackTable signals={signals} selected={selected} titleById={titleById} allVisibleSelected={allVisibleSelected} someVisibleSelected={someVisibleSelected} onToggle={toggle} onToggleAll={() => setSelected(allVisibleSelected ? new Set() : new Set(signals.map((s) => s.id)))} />}
      </> : <>
        <p className="text-sm text-gray-400">Saved human-curated scenarios. Ready scenarios can be copied into a deterministic experiment manifest.</p>
        <div className="flex flex-wrap gap-3 rounded-lg border border-gray-800 bg-gray-900/40 p-3">
          <label className="text-xs text-gray-500">Playbook<select aria-label="Scenario playbook filter" className="mt-1 block min-w-[12rem] rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-100" value={scenarioPlaybookId} onChange={(e) => setScenarioPlaybookId(e.target.value)}><option value="">All</option>{playbooks.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
          <label className="text-xs text-gray-500">Status<select aria-label="Scenario status filter" className="mt-1 block min-w-[9rem] rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-100" value={scenarioStatus} onChange={(e) => setScenarioStatus(e.target.value as EvaluationScenarioStatus | 'all')}><option value="all">All</option><option value="draft">Draft</option><option value="ready">Ready</option><option value="retired">Retired</option></select></label>
        </div>
        {editor && editorPlaybookId && <ScenarioEditor scenario={editorScenario} playbookId={editorPlaybookId} playbookTitle={titleById.get(editorPlaybookId) ?? editorPlaybookId} sourceSignals={editorSignals} error={editorError} busy={saveMutation.isPending} onCancel={() => { setEditor(null); setEditorError(null); }} onSave={(value, status) => saveMutation.mutate({ value, status })} />}
        {scenariosLoading && <p className="text-sm text-gray-500">Loading…</p>}
        {!scenariosLoading && scenarios.length === 0 && <p className="text-sm text-gray-500">No scenarios match these filters.</p>}
        <div className="space-y-2">{scenarios.map((scenario) => <article key={scenario.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-800 bg-gray-900/40 p-3"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="font-ui-display font-semibold">{scenario.name}</h2><Badge variant="outline">{scenario.status}</Badge></div><p className="text-sm text-gray-400">{scenario.description || 'No description'}</p><p className="font-mono text-xs text-gray-600">{scenario.id} · {titleById.get(scenario.targetPlaybookId) ?? scenario.targetPlaybookId} · {scenario.sourceSignalIds.length} signal(s) · {scenario.expectations.length} check(s)</p></div><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => openEditor(scenario)}><Pencil className="mr-1 h-3.5 w-3.5" />Edit</Button>{scenario.status === 'draft' && <Button size="sm" variant="gold" onClick={() => statusMutation.mutate({ id: scenario.id, status: 'ready' })}>Mark ready</Button>}{scenario.status !== 'retired' && <Button size="sm" variant="outline" onClick={() => statusMutation.mutate({ id: scenario.id, status: 'retired' })}>Retire</Button>}{scenario.status === 'ready' && <Button size="sm" onClick={() => void copyCase(scenario)}><Copy className="mr-1 h-3.5 w-3.5" />Copy case JSON</Button>}</div></article>)}</div>
      </>}
    </main>
  </div>;
}

function FeedbackTable({ signals, selected, titleById, allVisibleSelected, someVisibleSelected, onToggle, onToggleAll }: { signals: FeedbackSignal[]; selected: Set<string>; titleById: Map<string, string>; allVisibleSelected: boolean; someVisibleSelected: boolean; onToggle: (id: string) => void; onToggleAll: () => void }) {
  return <div className="overflow-x-auto rounded-lg border border-gray-800"><table className="w-full min-w-[48rem] text-left text-sm">
    <thead className="border-b border-gray-800 bg-gray-900/80 text-xs uppercase text-gray-500"><tr><th className="w-10 px-3 py-2"><Checkbox checked={allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false} onCheckedChange={onToggleAll} aria-label="Select all visible signals" className={CHECKBOX_CLASS} /></th><th className="px-3 py-2">Excerpt</th><th className="px-3 py-2">Failure</th><th className="px-3 py-2">Playbook</th><th className="px-3 py-2">Source</th><th className="px-3 py-2">When</th></tr></thead>
    <tbody>{signals.map((signal) => <tr key={signal.id} className="border-b border-gray-800/80 align-top"><td className="px-3 py-2"><Checkbox checked={selected.has(signal.id)} onCheckedChange={() => onToggle(signal.id)} aria-label={`Select ${signal.id}`} className={CHECKBOX_CLASS} /></td><td className="px-3 py-2"><p className="font-mono text-[11px] text-gray-600">{signal.id}</p><p className="text-gray-200">“{signal.userFeedbackExcerpt}”</p>{signalLooksInProposal(signal) && <Badge variant="outline" className="mt-1 text-[10px]">In proposal</Badge>}</td><td className="px-3 py-2 text-gray-400">{signal.failureSummary}</td><td className="px-3 py-2 text-gray-300">{signal.candidatePlaybookId ? titleById.get(signal.candidatePlaybookId) ?? signal.candidatePlaybookId : '—'}</td><td className="px-3 py-2 text-gray-500">{signal.source}</td><td className="whitespace-nowrap px-3 py-2 text-gray-500">{new Date(signal.createdAt).toLocaleString()}</td></tr>)}</tbody>
  </table></div>;
}
