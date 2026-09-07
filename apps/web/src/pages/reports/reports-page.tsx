import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, api, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton } from '../../components/ui';
import { Modal } from '../../components/modal';
import { useToast } from '../../components/toast';

interface ReportMeta {
  cached: boolean;
  generatedAt: string;
}

interface ReportEnvelope<T> {
  data: T;
  meta: ReportMeta;
}

interface ForecastTotals {
  dealCount: number;
  totalBaseAmount: number;
  weightedValue: number;
  commitBaseAmount: number;
  bestCaseBaseAmount: number;
  pipelineBaseAmount: number;
}

interface ForecastOwnerRow extends ForecastTotals {
  owner: { id: string; name: string };
}

interface ForecastStageRow {
  stage: { id: string; key: string; name: string; position: number; probability: number };
  dealCount: number;
  totalBaseAmount: number;
  weightedValue: number;
}

interface ForecastData {
  baseCurrency: string;
  totals: ForecastTotals;
  byOwner: ForecastOwnerRow[];
  pipelines: Array<{
    pipeline: { id: string; name: string; slug: string };
    stages: ForecastStageRow[];
  }>;
}

interface PipelineStageRow {
  stage: { id: string; key: string; name: string; position: number };
  open: { count: number; baseAmount: number };
  won: { count: number; baseAmount: number };
  lost: { count: number; baseAmount: number };
}

interface PipelineData {
  baseCurrency: string;
  pipelines: Array<{
    pipeline: { id: string; name: string; slug: string };
    stages: PipelineStageRow[];
  }>;
}

interface ActivityData {
  from: string | null;
  to: string | null;
  total: number;
  byType: Array<{ type: string; count: number }>;
  byOwner: Array<{ owner: { id: string; name: string }; count: number }>;
}

interface ConversionData {
  from: string | null;
  to: string | null;
  leads: {
    total: number;
    byStatus: Array<{ status: string; count: number }>;
    convertedRate: number;
  };
  deals: { open: number; won: number; lost: number; winRate: number; avgWonBaseAmount: number };
}

interface DashboardWidget {
  key: string;
  type: string;
  title?: string;
  config?: Record<string, unknown>;
}

interface DashboardDto {
  id: string;
  owner: { id: string; name: string } | null;
  ownerId: string | null;
  name: string;
  isDefault: boolean;
  layout: DashboardWidget[];
  createdAt: string;
  updatedAt: string;
}

interface DashboardsResponse {
  dashboards: DashboardDto[];
  nextCursor: string | null;
}

const WIDGET_TYPES = [
  { type: 'forecast-summary', label: 'Forecast summary' },
  { type: 'pipeline-funnel', label: 'Pipeline funnel' },
  { type: 'activity-chart', label: 'Activity chart' },
  { type: 'conversion-funnel', label: 'Conversion funnel' },
  { type: 'overdue-tasks', label: 'Overdue tasks' },
  { type: 'recent-activities', label: 'Recent activities' },
  { type: 'stalled-deals', label: 'Stalled deals' },
] as const;

type ReportTab = 'forecast' | 'pipeline' | 'activity' | 'conversion' | 'cohorts' | 'dashboards';

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function CacheNote({
  meta,
  onRefresh,
}: {
  meta: ReportMeta;
  onRefresh: () => void;
}): React.JSX.Element {
  return (
    <p className="flex items-center gap-2 text-xs text-text-secondary" aria-live="polite">
      <span>{meta.cached ? 'Served from 5-minute cache' : 'Live view'}</span>
      <button
        type="button"
        onClick={onRefresh}
        className="font-semibold text-accent hover:underline"
      >
        Refresh
      </button>
    </p>
  );
}

function ExportButton({ report }: { report: string }): React.JSX.Element {
  const { notify } = useToast();
  const [pending, setPending] = useState(false);

  async function download(): Promise<void> {
    setPending(true);
    try {
      const res = await fetch(`${API_URL}/v1/reports/${report}/export`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') ?? '';
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `${report}.csv`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify('success', `Exported ${filename}`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Export failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      variant="secondary"
      onClick={() => void download()}
      disabled={pending}
      className="h-7 text-xs"
    >
      {pending ? 'Exporting…' : 'Export CSV'}
    </Button>
  );
}

export function ReportsPage(): React.JSX.Element {
  const { user } = useAuth();
  const [tab, setTab] = useState<ReportTab>('forecast');
  const canManageDashboards = hasScope(user, 'dashboards:manage');

  const tabs: Array<{ key: ReportTab; label: string }> = [
    { key: 'forecast', label: 'Forecast' },
    { key: 'pipeline', label: 'Pipeline' },
    { key: 'activity', label: 'Activity' },
    { key: 'conversion', label: 'Conversion' },
    { key: 'cohorts', label: 'Cohorts' },
    { key: 'dashboards', label: 'Dashboards' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight text-text-primary">Reports</h1>
      <div className="flex gap-2" role="group" aria-label="Report types">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            aria-pressed={tab === t.key}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              tab === t.key
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:bg-surface-raised hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'forecast' && <ForecastPanel />}
      {tab === 'pipeline' && <PipelinePanel />}
      {tab === 'activity' && <ActivityPanel />}
      {tab === 'conversion' && <ConversionPanel />}
      {tab === 'cohorts' && <CohortsPanel />}
      {tab === 'dashboards' && <DashboardsPanel canManage={canManageDashboards} />}
    </div>
  );
}

function ForecastPanel(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [refresh, setRefresh] = useState(0);
  const forecastQuery = useQuery({
    queryKey: ['report-forecast', refresh],
    queryFn: () =>
      api<ReportEnvelope<ForecastData>>(`/reports/forecast${refresh > 0 ? '?refresh=true' : ''}`),
  });

  if (forecastQuery.isLoading) return <Skeleton className="h-64 w-full" />;
  if (forecastQuery.isError || !forecastQuery.data) {
    return (
      <div className="rounded bg-danger-soft p-4 text-sm text-danger">
        Could not load forecast: {forecastQuery.error?.message}
      </div>
    );
  }
  const { data, meta } = forecastQuery.data;
  const cards: Array<{ label: string; value: string }> = [
    { label: 'Pipeline', value: money(data.totals.pipelineBaseAmount, data.baseCurrency) },
    { label: 'Best case', value: money(data.totals.bestCaseBaseAmount, data.baseCurrency) },
    { label: 'Commit', value: money(data.totals.commitBaseAmount, data.baseCurrency) },
    { label: 'Weighted', value: money(data.totals.weightedValue, data.baseCurrency) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <CacheNote
          meta={meta}
          onRefresh={() => {
            setRefresh((n) => n + 1);
            void queryClient.invalidateQueries({ queryKey: ['report-forecast'] });
          }}
        />
        <ExportButton report="forecast" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label} title={c.label} description="">
            <p className="text-lg font-bold text-text-primary">{c.value}</p>
            <p className="text-xs text-text-secondary">{data.totals.dealCount} open deals</p>
          </Card>
        ))}
      </div>
      <Card
        title="Forecast by rep"
        description="Commit and best case roll up from deal categories."
      >
        {data.byOwner.length === 0 ? (
          <EmptyState title="No open deals" description="Create a deal to populate the forecast." />
        ) : (
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-text-secondary">
                <th className="py-1 pr-2">Rep</th>
                <th className="py-1 pr-2 text-right">Deals</th>
                <th className="py-1 pr-2 text-right">Pipeline</th>
                <th className="py-1 pr-2 text-right">Best case</th>
                <th className="py-1 text-right">Commit</th>
              </tr>
            </thead>
            <tbody>
              {data.byOwner.map((row) => (
                <tr key={row.owner.id} className="border-t border-border">
                  <td className="py-1.5 pr-2 font-medium">{row.owner.name}</td>
                  <td className="py-1.5 pr-2 text-right">{row.dealCount}</td>
                  <td className="py-1.5 pr-2 text-right">
                    {money(row.pipelineBaseAmount, data.baseCurrency)}
                  </td>
                  <td className="py-1.5 pr-2 text-right">
                    {money(row.bestCaseBaseAmount, data.baseCurrency)}
                  </td>
                  <td className="py-1.5 text-right font-semibold text-accent">
                    {money(row.commitBaseAmount, data.baseCurrency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {data.pipelines.map((p) => (
        <Card key={p.pipeline.id} title={`${p.pipeline.name} by stage`} description="">
          <ul className="flex flex-col gap-1 text-xs">
            {p.stages.map((s) => (
              <li key={s.stage.id} className="flex justify-between gap-2 py-1">
                <span>
                  {s.stage.name} ({s.stage.probability}%)
                </span>
                <span className="text-text-secondary">
                  {s.dealCount} deals · {money(s.totalBaseAmount, data.baseCurrency)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function PipelinePanel(): React.JSX.Element {
  const pipelineQuery = useQuery({
    queryKey: ['report-pipeline'],
    queryFn: () => api<ReportEnvelope<PipelineData>>('/reports/pipeline'),
  });

  if (pipelineQuery.isLoading) return <Skeleton className="h-64 w-full" />;
  if (pipelineQuery.isError || !pipelineQuery.data) {
    return (
      <div className="rounded bg-danger-soft p-4 text-sm text-danger">
        Could not load pipeline report: {pipelineQuery.error?.message}
      </div>
    );
  }
  const { data, meta } = pipelineQuery.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <CacheNote meta={meta} onRefresh={() => void pipelineQuery.refetch()} />
        <ExportButton report="pipeline" />
      </div>
      {data.pipelines.map((p) => (
        <Card
          key={p.pipeline.id}
          title={p.pipeline.name}
          description="Open, won, and lost per stage."
        >
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-text-secondary">
                <th className="py-1 pr-2">Stage</th>
                <th className="py-1 pr-2 text-right">Open</th>
                <th className="py-1 pr-2 text-right">Won</th>
                <th className="py-1 text-right">Lost</th>
              </tr>
            </thead>
            <tbody>
              {p.stages.map((s) => (
                <tr key={s.stage.id} className="border-t border-border">
                  <td className="py-1.5 pr-2 font-medium">{s.stage.name}</td>
                  <td className="py-1.5 pr-2 text-right">
                    {s.open.count} · {money(s.open.baseAmount, data.baseCurrency)}
                  </td>
                  <td className="py-1.5 pr-2 text-right text-success">
                    {s.won.count} · {money(s.won.baseAmount, data.baseCurrency)}
                  </td>
                  <td className="py-1.5 text-right text-danger">
                    {s.lost.count} · {money(s.lost.baseAmount, data.baseCurrency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}

function ActivityPanel(): React.JSX.Element {
  const [from, setFrom] = useState('');
  const [applied, setApplied] = useState('');
  const activityQuery = useQuery({
    queryKey: ['report-activity', applied],
    queryFn: () =>
      api<ReportEnvelope<ActivityData>>(`/reports/activity${applied ? `?from=${applied}` : ''}`),
  });

  if (activityQuery.isLoading) return <Skeleton className="h-64 w-full" />;
  if (activityQuery.isError || !activityQuery.data) {
    return (
      <div className="rounded bg-danger-soft p-4 text-sm text-danger">
        Could not load activity report: {activityQuery.error?.message}
      </div>
    );
  }
  const { data, meta } = activityQuery.data;
  const max = Math.max(1, ...data.byType.map((t) => t.count));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <CacheNote meta={meta} onRefresh={() => void activityQuery.refetch()} />
        <ExportButton report="activity" />
      </div>
      <Card title="Filters" description="">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(from);
          }}
        >
          <Field label="From date" htmlFor="activity-from">
            <Input
              id="activity-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="secondary" className="h-9 text-xs">
            Apply
          </Button>
          {applied && (
            <Button
              type="button"
              variant="ghost"
              className="h-9 text-xs"
              onClick={() => {
                setFrom('');
                setApplied('');
              }}
            >
              Clear
            </Button>
          )}
        </form>
      </Card>
      <Card title={`Activity by type · ${data.total} total`} description="">
        {data.byType.length === 0 ? (
          <EmptyState title="No activity" description="Log calls, meetings, emails, or notes." />
        ) : (
          <ul className="flex flex-col gap-2 text-xs">
            {data.byType.map((t) => (
              <li key={t.type} className="flex items-center gap-2">
                <span className="w-24 shrink-0 font-medium capitalize">{t.type}</span>
                <span
                  className="h-3 rounded bg-accent"
                  style={{ width: `${Math.max(4, Math.round((t.count / max) * 160))}px` }}
                />
                <span className="text-text-secondary">{t.count}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Activity by rep" description="">
        <ul className="flex flex-col gap-1 text-xs">
          {data.byOwner.map((row) => (
            <li key={row.owner.id} className="flex justify-between gap-2 py-1">
              <span className="font-medium">{row.owner.name}</span>
              <span className="text-text-secondary">{row.count}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function ConversionPanel(): React.JSX.Element {
  const conversionQuery = useQuery({
    queryKey: ['report-conversion'],
    queryFn: () => api<ReportEnvelope<ConversionData>>('/reports/conversion'),
  });

  if (conversionQuery.isLoading) return <Skeleton className="h-64 w-full" />;
  if (conversionQuery.isError || !conversionQuery.data) {
    return (
      <div className="rounded bg-danger-soft p-4 text-sm text-danger">
        Could not load conversion report: {conversionQuery.error?.message}
      </div>
    );
  }
  const { data, meta } = conversionQuery.data;
  const leadMax = Math.max(1, ...data.leads.byStatus.map((s) => s.count));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <CacheNote meta={meta} onRefresh={() => void conversionQuery.refetch()} />
        <ExportButton report="conversion" />
      </div>
      <Card
        title={`Lead funnel · ${data.leads.total} leads · ${data.leads.convertedRate}% converted`}
        description=""
      >
        <ul className="flex flex-col gap-2 text-xs">
          {data.leads.byStatus.map((s) => (
            <li key={s.status} className="flex items-center gap-2">
              <span className="w-24 shrink-0 font-medium capitalize">{s.status}</span>
              <span
                className="h-3 rounded bg-accent"
                style={{ width: `${Math.max(4, Math.round((s.count / leadMax) * 160))}px` }}
              />
              <span className="text-text-secondary">{s.count}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Deal outcomes" description="">
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge tone="neutral">Open {data.deals.open}</Badge>
          <Badge tone="success">Won {data.deals.won}</Badge>
          <Badge tone="danger">Lost {data.deals.lost}</Badge>
          <Badge tone="info">Win rate {data.deals.winRate}%</Badge>
        </div>
        <p className="mt-2 text-xs text-text-secondary">
          Average won deal size:{' '}
          {data.deals.avgWonBaseAmount.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </p>
      </Card>
    </div>
  );
}

interface CohortEntry {
  cohort: string;
  size: number;
  byLifecycle: Record<string, number>;
}

interface TrendEntry {
  week: string;
  created: number;
  won: number;
  wonBaseAmount: number;
}

interface CohortsData {
  cohorts: CohortEntry[];
  weeklyTrend: TrendEntry[];
}

function CohortsPanel(): React.JSX.Element {
  const cohortsQuery = useQuery({
    queryKey: ['report-cohorts'],
    queryFn: () => api<ReportEnvelope<CohortsData>>('/reports/cohorts'),
  });

  if (cohortsQuery.isLoading) return <Skeleton className="h-64 w-full" />;
  if (cohortsQuery.isError || !cohortsQuery.data) {
    return (
      <div className="rounded bg-danger-soft p-4 text-sm text-danger">
        Could not load cohorts report: {cohortsQuery.error?.message}
      </div>
    );
  }
  const { data, meta } = cohortsQuery.data;
  const weekMax = Math.max(1, ...data.weeklyTrend.map((w) => w.created));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <CacheNote meta={meta} onRefresh={() => void cohortsQuery.refetch()} />
      </div>
      <Card
        title="Contact cohorts by creation month"
        description="Lifecycle progression per cohort."
      >
        {data.cohorts.length === 0 ? (
          <p className="text-xs italic text-text-secondary">No contacts yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-xs">
            {data.cohorts.map((c) => (
              <li
                key={c.cohort}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-4 py-3"
              >
                <span className="text-sm font-medium text-text-primary">{c.cohort}</span>
                <Badge tone="info">{c.size} contacts</Badge>
                {Object.entries(c.byLifecycle).map(([stage, count]) => (
                  <span key={stage} className="text-text-secondary">
                    {stage}: {count}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Weekly deal flow" description="Created vs won deals per week.">
        {data.weeklyTrend.length === 0 ? (
          <p className="text-xs italic text-text-secondary">No deals yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-xs">
            {data.weeklyTrend.map((w) => (
              <li key={w.week} className="flex items-center gap-2">
                <span className="w-24 shrink-0 font-medium">{w.week}</span>
                <span
                  className="h-3 rounded bg-accent"
                  style={{ width: `${Math.max(4, Math.round((w.created / weekMax) * 160))}px` }}
                />
                <span className="text-text-secondary">
                  {w.created} created · {w.won} won
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function DashboardsPanel({ canManage }: { canManage: boolean }): React.JSX.Element {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const dashboardsQuery = useQuery({
    queryKey: ['dashboards'],
    queryFn: () => api<DashboardsResponse>('/dashboards'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/dashboards/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setSelectedId(null);
      void queryClient.invalidateQueries({ queryKey: ['dashboards'] });
      notify('success', 'Dashboard deleted');
    },
    onError: (err: Error) => notify('error', err.message || 'Failed to delete dashboard'),
  });

  const boards = dashboardsQuery.data?.dashboards ?? [];
  const selected =
    boards.find((b) => b.id === selectedId) ?? boards.find((b) => b.isDefault) ?? boards[0] ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Dashboards">
          {boards.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setSelectedId(b.id)}
              aria-pressed={selected?.id === b.id}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                selected?.id === b.id
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:bg-surface-raised hover:text-text-primary'
              }`}
            >
              {b.name}
              {b.isDefault ? ' ★' : ''}
            </button>
          ))}
        </div>
        {canManage && (
          <Button variant="primary" onClick={() => setCreateOpen(true)} className="h-9 text-xs">
            + New Dashboard
          </Button>
        )}
      </div>

      {dashboardsQuery.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : !selected ? (
        <EmptyState
          title="No dashboards yet"
          description="Create one from the forecast, pipeline, activity, and task widgets."
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">
              {selected.name}
              {selected.isDefault && (
                <span className="ml-2 text-xs font-normal text-text-secondary">(default)</span>
              )}
            </h2>
            {canManage && (
              <Button
                variant="ghost"
                className="h-8 text-xs text-danger"
                onClick={() => deleteMutation.mutate(selected.id)}
                aria-label={`Delete dashboard ${selected.name}`}
              >
                Delete
              </Button>
            )}
          </div>
          {selected.layout.length === 0 ? (
            <EmptyState
              title="Empty dashboard"
              description="Edit is not supported yet — recreate with widgets."
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {selected.layout.map((widget) => (
                <DashboardWidgetView
                  key={String(widget['key'] ?? widget['type'])}
                  widget={widget}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <CreateDashboardModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setSelectedId(id);
          void queryClient.invalidateQueries({ queryKey: ['dashboards'] });
        }}
      />
    </div>
  );
}

function DashboardWidgetView({ widget }: { widget: DashboardWidget }): React.JSX.Element {
  const title = String(widget['title'] ?? widget['type']);
  const type = String(widget['type']);

  if (type === 'forecast-summary') {
    return (
      <WidgetCard title={title}>
        <WidgetQuery
          queryKey={['widget-forecast']}
          url="/reports/forecast"
          render={(payload: ReportEnvelope<ForecastData>) => (
            <div className="flex flex-col gap-1 text-xs">
              <span>
                Pipeline {money(payload.data.totals.pipelineBaseAmount, payload.data.baseCurrency)}
              </span>
              <span>
                Best case {money(payload.data.totals.bestCaseBaseAmount, payload.data.baseCurrency)}
              </span>
              <span className="font-semibold text-accent">
                Commit {money(payload.data.totals.commitBaseAmount, payload.data.baseCurrency)}
              </span>
            </div>
          )}
        />
      </WidgetCard>
    );
  }

  if (type === 'pipeline-funnel') {
    return (
      <WidgetCard title={title}>
        <WidgetQuery
          queryKey={['widget-pipeline']}
          url="/reports/pipeline"
          render={(payload: ReportEnvelope<PipelineData>) => (
            <div className="flex flex-col gap-2 text-xs">
              {(payload.data.pipelines[0]?.stages ?? []).map((s) => (
                <div key={s.stage.id} className="flex justify-between gap-2">
                  <span>{s.stage.name}</span>
                  <span className="text-text-secondary">{s.open.count} open</span>
                </div>
              ))}
            </div>
          )}
        />
      </WidgetCard>
    );
  }

  if (type === 'activity-chart') {
    return (
      <WidgetCard title={title}>
        <WidgetQuery
          queryKey={['widget-activity']}
          url="/reports/activity"
          render={(payload: ReportEnvelope<ActivityData>) => (
            <div className="flex flex-col gap-1 text-xs">
              {(payload.data.byType ?? []).map((t) => (
                <div key={t.type} className="flex justify-between gap-2">
                  <span className="capitalize">{t.type}</span>
                  <span className="text-text-secondary">{t.count}</span>
                </div>
              ))}
            </div>
          )}
        />
      </WidgetCard>
    );
  }

  if (type === 'conversion-funnel') {
    return (
      <WidgetCard title={title}>
        <WidgetQuery
          queryKey={['widget-conversion']}
          url="/reports/conversion"
          render={(payload: ReportEnvelope<ConversionData>) => (
            <div className="flex flex-col gap-1 text-xs">
              <span>Leads converted {payload.data.leads.convertedRate}%</span>
              <span>Deal win rate {payload.data.deals.winRate}%</span>
            </div>
          )}
        />
      </WidgetCard>
    );
  }

  if (type === 'overdue-tasks') {
    return (
      <WidgetCard title={title}>
        <WidgetQuery
          queryKey={['widget-overdue']}
          url="/tasks?overdue=true"
          render={(payload: { tasks: Array<{ id: string; title: string }> }) => (
            <div className="flex flex-col gap-1 text-xs">
              {payload.tasks.length === 0 ? (
                <span className="italic text-text-secondary">Nothing overdue.</span>
              ) : (
                payload.tasks.slice(0, 5).map((t) => <span key={t.id}>• {t.title}</span>)
              )}
            </div>
          )}
        />
      </WidgetCard>
    );
  }

  if (type === 'stalled-deals') {
    return (
      <WidgetCard title={title}>
        <WidgetQuery
          queryKey={['widget-stalled']}
          url="/deals/stalled?limit=5"
          render={(payload: {
            deals: Array<{ id: string; name: string; daysInactive: number }>;
            thresholdDays: number;
          }) => (
            <div className="flex flex-col gap-1 text-xs">
              {payload.deals.length === 0 ? (
                <span className="italic text-text-secondary">
                  No deals inactive beyond {payload.thresholdDays} days.
                </span>
              ) : (
                payload.deals.map((d) => (
                  <span key={d.id}>
                    • {d.name}{' '}
                    <span className="font-semibold text-warning">{d.daysInactive}d inactive</span>
                  </span>
                ))
              )}
            </div>
          )}
        />
      </WidgetCard>
    );
  }

  return (
    <WidgetCard title={title}>
      <WidgetQuery
        queryKey={['widget-recent']}
        url="/activities?limit=5"
        render={(payload: {
          activities: Array<{ id: string; type: string; subject: string | null }>;
        }) => (
          <div className="flex flex-col gap-1 text-xs">
            {payload.activities.length === 0 ? (
              <span className="italic text-text-secondary">No recent activity.</span>
            ) : (
              payload.activities.map((a) => (
                <span key={a.id}>
                  <Badge tone="info">{a.type}</Badge> {a.subject ?? '(no subject)'}
                </span>
              ))
            )}
          </div>
        )}
      />
    </WidgetCard>
  );
}

function WidgetCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      aria-label={`Widget ${title}`}
      className="rounded-lg border border-border bg-surface p-4 shadow-subtle"
    >
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function WidgetQuery<T>({
  queryKey,
  url,
  render,
}: {
  queryKey: string[];
  url: string;
  render: (payload: T) => React.JSX.Element;
}): React.JSX.Element {
  const query = useQuery({ queryKey, queryFn: () => api<T>(url) });
  if (query.isLoading) return <Skeleton className="h-16 w-full" />;
  if (query.isError || !query.data) {
    return <p className="text-xs text-danger">Could not load widget.</p>;
  }
  return render(query.data);
}

function CreateDashboardModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}): React.JSX.Element {
  const { notify } = useToast();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>(['forecast-summary']);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: async (): Promise<{ dashboard: DashboardDto }> => {
      if (!name.trim()) throw new Error('Name is required');
      if (picked.length === 0) throw new Error('Pick at least one widget');
      return api<{ dashboard: DashboardDto }>('/dashboards', {
        method: 'POST',
        body: {
          name: name.trim(),
          layout: picked.map((type, idx) => ({ key: `w${idx + 1}`, type })),
        },
      });
    },
    onSuccess: ({ dashboard }) => {
      setName('');
      setPicked(['forecast-summary']);
      setError(null);
      onClose();
      onCreated(dashboard.id);
      notify('success', `Dashboard "${dashboard.name}" created`);
    },
    onError: (err: Error) => setError(err.message || 'Failed to create dashboard'),
  });

  function toggle(type: string): void {
    setPicked((prev) => (prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New Dashboard"
      description="Pick the widgets to show."
    >
      <form
        className="flex flex-col gap-3 pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          createMutation.mutate();
        }}
      >
        {error && (
          <div role="alert" className="rounded bg-danger-soft p-3 text-xs text-danger">
            {error}
          </div>
        )}
        <Field label="Name" htmlFor="new-dashboard-name">
          <Input
            id="new-dashboard-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sales overview"
          />
        </Field>
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-text-primary">Widgets</legend>
          <div className="flex flex-col gap-1">
            {WIDGET_TYPES.map((w) => (
              <label key={w.type} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={picked.includes(w.type)}
                  onChange={() => toggle(w.type)}
                />
                {w.label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Creating…' : 'Create Dashboard'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
