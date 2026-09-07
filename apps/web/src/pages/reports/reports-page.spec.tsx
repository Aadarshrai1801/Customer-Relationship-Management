import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReportsPage } from './reports-page';

const mockApi = vi.fn();
const mockNotify = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useNavigate: () => vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  api: (...args: unknown[]) => mockApi(...args),
  hasScope: () => true,
  API_URL: 'http://localhost:3001',
}));

vi.mock('../../lib/providers', () => ({
  useAuth: () => ({
    user: { id: 'u-1', name: 'Alice Owner', role: { permissions: { scopes: ['*'] } } },
    org: { id: 'org-1', name: 'Acme Org', slug: 'acme' },
  }),
}));

vi.mock('../../components/toast', () => ({
  useToast: () => ({ notify: mockNotify }),
}));

const FORECAST = {
  data: {
    baseCurrency: 'USD',
    totals: {
      dealCount: 2,
      totalBaseAmount: 30000,
      weightedValue: 3000,
      commitBaseAmount: 10000,
      bestCaseBaseAmount: 30000,
      pipelineBaseAmount: 30000,
    },
    byOwner: [
      {
        owner: { id: 'u-1', name: 'Alice Owner' },
        dealCount: 2,
        totalBaseAmount: 30000,
        weightedValue: 3000,
        commitBaseAmount: 10000,
        bestCaseBaseAmount: 30000,
        pipelineBaseAmount: 30000,
      },
    ],
    pipelines: [
      {
        pipeline: { id: 'p-1', name: 'Sales', slug: 'sales' },
        stages: [
          {
            stage: { id: 's-1', key: 'discovery', name: 'Discovery', position: 1, probability: 10 },
            dealCount: 2,
            totalBaseAmount: 30000,
            weightedValue: 3000,
          },
        ],
      },
    ],
  },
  meta: { cached: false, generatedAt: new Date().toISOString() },
};

const PIPELINE = {
  data: {
    baseCurrency: 'USD',
    pipelines: [
      {
        pipeline: { id: 'p-1', name: 'Sales', slug: 'sales' },
        stages: [
          {
            stage: { id: 's-1', key: 'discovery', name: 'Discovery', position: 1 },
            open: { count: 2, baseAmount: 30000 },
            won: { count: 1, baseAmount: 20000 },
            lost: { count: 0, baseAmount: 0 },
          },
        ],
      },
    ],
  },
  meta: { cached: true, generatedAt: new Date().toISOString() },
};

const ACTIVITY = {
  data: {
    from: null,
    to: null,
    total: 3,
    byType: [
      { type: 'call', count: 2 },
      { type: 'note', count: 1 },
    ],
    byOwner: [{ owner: { id: 'u-1', name: 'Alice Owner' }, count: 3 }],
  },
  meta: { cached: false, generatedAt: new Date().toISOString() },
};

const CONVERSION = {
  data: {
    from: null,
    to: null,
    leads: {
      total: 4,
      byStatus: [
        { status: 'new', count: 1 },
        { status: 'converted', count: 1 },
      ],
      convertedRate: 25,
    },
    deals: { open: 1, won: 2, lost: 1, winRate: 66.67, avgWonBaseAmount: 15000 },
  },
  meta: { cached: false, generatedAt: new Date().toISOString() },
};

function setupApi(overrides?: { dashboards?: unknown[] }) {
  mockApi.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.startsWith('/reports/forecast')) return Promise.resolve(FORECAST);
    if (url.startsWith('/reports/pipeline')) return Promise.resolve(PIPELINE);
    if (url.startsWith('/reports/activity')) return Promise.resolve(ACTIVITY);
    if (url.startsWith('/reports/conversion')) return Promise.resolve(CONVERSION);
    if (url === '/dashboards' && init?.method === 'POST') {
      const body = (init as { body?: Record<string, unknown> }).body ?? {};
      return Promise.resolve({
        dashboard: { id: 'd-new', name: body['name'], isDefault: false, layout: body['layout'] },
      });
    }
    if (url.startsWith('/dashboards')) {
      return Promise.resolve({ dashboards: overrides?.dashboards ?? [], nextCursor: null });
    }
    if (url.startsWith('/tasks')) return Promise.resolve({ tasks: [], nextCursor: null });
    return Promise.reject(new Error(`unexpected api call ${url}`));
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ReportsPage />
    </QueryClientProvider>,
  );
}

describe('ReportsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupApi();
  });

  it('renders forecast buckets and the by-rep table', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Reports', level: 1 });
    expect(await screen.findByText('Alice Owner')).toBeInTheDocument();
    expect(screen.getByText(/Live view/)).toBeInTheDocument();
    expect(screen.getAllByText(/2 open deals/)[0]).toBeInTheDocument();
  });

  it('switches to pipeline, activity, and conversion tabs', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Reports', level: 1 });

    await user.click(screen.getByRole('button', { name: 'Pipeline' }));
    expect(await screen.findByText('Discovery')).toBeInTheDocument();
    expect(screen.getByText(/Served from 5-minute cache/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Activity' }));
    expect(await screen.findByText(/3 total/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Conversion' }));
    expect(await screen.findByText(/Win rate 66.67%/)).toBeInTheDocument();
  });

  it('creates a dashboard from picked widgets', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Reports', level: 1 });

    await user.click(screen.getByRole('button', { name: 'Dashboards' }));
    expect(await screen.findByText('No dashboards yet')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '+ New Dashboard' }));
    await user.type(screen.getByLabelText('Name'), 'Sales overview');
    await user.click(screen.getByRole('button', { name: 'Create Dashboard' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/dashboards',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ name: 'Sales overview' }),
        }),
      ),
    );
  });

  it('renders widgets for the selected dashboard', async () => {
    setupApi({
      dashboards: [
        {
          id: 'd-1',
          name: 'Sales overview',
          isDefault: true,
          layout: [
            { key: 'w1', type: 'forecast-summary', title: 'Forecast' },
            { key: 'w2', type: 'overdue-tasks', title: 'Stalled' },
          ],
        },
      ],
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Reports', level: 1 });

    await userEvent.setup().click(screen.getByRole('button', { name: 'Dashboards' }));
    expect(await screen.findByRole('region', { name: 'Widget Forecast' })).toBeInTheDocument();
  });
});
