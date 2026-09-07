import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PipelineBoardPage } from './pipeline-board';

const mockApi = vi.fn();
const mockNotify = vi.fn();

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

const STAGES = [
  {
    id: 'stage-discovery',
    key: 'discovery',
    name: 'Discovery',
    position: 1,
    probability: 10,
    isClosedWon: false,
    isClosedLost: false,
  },
  {
    id: 'stage-proposal',
    key: 'proposal',
    name: 'Proposal',
    position: 2,
    probability: 50,
    isClosedWon: false,
    isClosedLost: false,
  },
  {
    id: 'stage-won',
    key: 'closed-won',
    name: 'Closed Won',
    position: 3,
    probability: 100,
    isClosedWon: true,
    isClosedLost: false,
  },
  {
    id: 'stage-lost',
    key: 'closed-lost',
    name: 'Closed Lost',
    position: 4,
    probability: 0,
    isClosedWon: false,
    isClosedLost: true,
  },
];

const DEAL_1 = {
  id: 'deal-1',
  pipeline: { id: 'pipe-1', name: 'Sales Pipeline', slug: 'sales' },
  stage: { ...STAGES[0] },
  account: null,
  contact: null,
  owner: { id: 'u-1', name: 'Alice Owner' },
  ownerId: 'u-1',
  name: 'Acme Expansion',
  amount: 10000,
  currency: 'USD',
  baseCurrency: 'USD',
  baseAmount: 10000,
  exchangeRate: 1,
  exchangeRateDate: '2026-09-07',
  probability: null,
  effectiveProbability: 10,
  weightedValue: 1000,
  expectedCloseDate: null,
  closeDateStatus: null,
  status: 'open',
  lossReason: null,
  closedAt: null,
  customFields: {},
  computedFields: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const FORECAST = {
  pipeline: { id: 'pipe-1', name: 'Sales Pipeline', slug: 'sales' },
  baseCurrency: 'USD',
  stages: [
    {
      stage: STAGES[0],
      dealCount: 1,
      totalBaseAmount: 10000,
      weightedValue: 1000,
      overdueCount: 0,
      overdueBaseAmount: 0,
    },
    {
      stage: STAGES[1],
      dealCount: 0,
      totalBaseAmount: 0,
      weightedValue: 0,
      overdueCount: 0,
      overdueBaseAmount: 0,
    },
  ],
  totals: { dealCount: 1, totalBaseAmount: 10000, weightedValue: 1000 },
};

function setupApi(overrides?: {
  stageHandler?: (url: string, init?: { body?: unknown }) => Promise<unknown>;
  lineItems?: unknown[];
}) {
  mockApi.mockImplementation((url: string, init?: { method?: string; body?: unknown }) => {
    if (url === '/pipelines') {
      return Promise.resolve([
        {
          pipeline: {
            id: 'pipe-1',
            name: 'Sales Pipeline',
            slug: 'sales',
            description: null,
            isDefault: true,
          },
          stages: STAGES,
        },
      ]);
    }
    if (url === '/users') return Promise.resolve({ users: [] });
    if (url.startsWith('/deals/forecast')) return Promise.resolve(FORECAST);
    if (url.startsWith('/deals?')) {
      return Promise.resolve({ deals: [{ ...DEAL_1 }], nextCursor: null });
    }
    if (url.endsWith('/line-items')) return Promise.resolve(overrides?.lineItems ?? []);
    if (url.includes('/stage') && init?.method === 'POST') {
      if (overrides?.stageHandler) return overrides.stageHandler(url, init);
      return Promise.resolve({ deal: DEAL_1, changed: true });
    }
    return Promise.resolve({});
  });
}

function renderBoard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PipelineBoardPage />
    </QueryClientProvider>,
  );
}

describe('PipelineBoardPage', () => {
  beforeEach(() => {
    mockApi.mockReset();
    mockNotify.mockReset();
    setupApi();
  });

  it('renders stage columns with header sums and the weighted forecast header', async () => {
    renderBoard();
    expect(await screen.findByRole('heading', { name: 'Pipeline' })).toBeInTheDocument();
    expect(await screen.findByRole('listitem', { name: 'Discovery column' })).toBeInTheDocument();
    expect(await screen.findByRole('listitem', { name: 'Closed Lost column' })).toBeInTheDocument();
    expect(await screen.findByText('Acme Expansion')).toBeInTheDocument();
    expect(screen.getByText(/1 open deals/)).toBeInTheDocument();
    expect(screen.getByText(/1,000.00 weighted/)).toBeInTheDocument();
  });

  it('moves a card optimistically and syncs in the background', async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Acme Expansion');

    const select = screen.getByRole('combobox', { name: 'Move Acme Expansion to stage' });
    await user.selectOptions(select, 'stage-proposal');

    expect(mockApi).toHaveBeenCalledWith(
      '/deals/deal-1/stage',
      expect.objectContaining({ method: 'POST' }),
    );
    await waitFor(() => expect(mockNotify).toHaveBeenCalledWith('success', 'Deal stage updated'));
  });

  it('rolls back the optimistic move and toasts when sync fails', async () => {
    const user = userEvent.setup();
    setupApi({
      stageHandler: () => Promise.reject(new Error('Server exploded')),
    });
    renderBoard();
    await screen.findByText('Acme Expansion');

    const discoveryColumn = screen.getByRole('listitem', { name: 'Discovery column' });
    const select = within(discoveryColumn).getByRole('combobox', {
      name: 'Move Acme Expansion to stage',
    });
    await user.selectOptions(select, 'stage-proposal');

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith('/deals/deal-1/stage', expect.anything()),
    );
    await waitFor(() =>
      expect(mockNotify).toHaveBeenCalledWith('error', expect.stringMatching(/rolled back/)),
    );
    expect(within(discoveryColumn).getByText('Acme Expansion')).toBeInTheDocument();
  });

  it('requires a loss reason before moving to Closed Lost', async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Acme Expansion');

    const select = screen.getByRole('combobox', { name: 'Move Acme Expansion to stage' });
    await user.selectOptions(select, 'stage-lost');

    expect(await screen.findByText('Close as lost')).toBeInTheDocument();
    // Nothing synced yet — the modal gates the request.
    expect(mockApi).not.toHaveBeenCalledWith('/deals/deal-1/stage', expect.anything());

    const confirm = screen.getByRole('button', { name: 'Move to lost' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Loss reason'), 'Chose a competitor');
    await user.click(confirm);

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/deals/deal-1/stage',
        expect.objectContaining({
          body: expect.objectContaining({
            stageId: 'stage-lost',
            lossReason: 'Chose a competitor',
          }),
        }),
      ),
    );
  });

  it('prompts (without blocking) on Closed Won when no line items exist', async () => {
    const user = userEvent.setup();
    setupApi({ lineItems: [] });
    renderBoard();
    await screen.findByText('Acme Expansion');

    const select = screen.getByRole('combobox', { name: 'Move Acme Expansion to stage' });
    await user.selectOptions(select, 'stage-won');

    expect(await screen.findByText('Close as won')).toBeInTheDocument();
    expect(mockApi).not.toHaveBeenCalledWith('/deals/deal-1/stage', expect.anything());

    await user.click(screen.getByRole('button', { name: 'Proceed without products' }));
    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/deals/deal-1/stage',
        expect.objectContaining({
          body: expect.objectContaining({ stageId: 'stage-won' }),
        }),
      ),
    );
  });

  it('skips the won prompt when line items exist', async () => {
    const user = userEvent.setup();
    setupApi({
      lineItems: [{ id: 'li-1', name: 'Widget', quantity: '2', unitPrice: '50', currency: 'USD' }],
    });
    renderBoard();
    await screen.findByText('Acme Expansion');

    const select = screen.getByRole('combobox', { name: 'Move Acme Expansion to stage' });
    await user.selectOptions(select, 'stage-won');

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith('/deals/deal-1/stage', expect.anything()),
    );
    expect(screen.queryByText('Close as won')).not.toBeInTheDocument();
    void user;
  });

  it('filters cards by minimum probability', async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Acme Expansion');
    const slider = screen.getByLabelText(/Min probability/);
    fireEvent.change(slider, { target: { value: '50' } });
    await waitFor(() => expect(screen.queryByText('Acme Expansion')).not.toBeInTheDocument());
    void user;
  });
});
