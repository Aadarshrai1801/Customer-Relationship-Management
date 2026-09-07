import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DealDetailPage } from './deal-detail';

const mockApi = vi.fn();
const mockNotify = vi.fn();
const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
  useParams: () => ({ id: 'deal-1' }),
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

const DEAL = {
  id: 'deal-1',
  pipeline: { id: 'pipe-1', name: 'Sales Pipeline', slug: 'sales' },
  stage: { ...STAGES[0] },
  account: { id: 'acct-1', name: 'Acme Inc' },
  contact: { id: 'c-1', name: 'Amy Buyer', email: 'amy@example.test' },
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

function setupApi(overrides?: {
  lineItems?: unknown[];
  products?: unknown[];
  onDelete?: () => void;
}) {
  mockApi.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/deals/deal-1' && init?.method === 'DELETE') {
      overrides?.onDelete?.();
      return Promise.resolve({ ok: true });
    }
    if (url === '/deals/deal-1' && init?.method === 'PATCH') {
      const body = (init as { body?: Record<string, unknown> }).body ?? {};
      return Promise.resolve({ deal: { ...DEAL, ...body } });
    }
    if (url === '/deals/deal-1') return Promise.resolve({ ...DEAL });
    if (url === '/deals/deal-1/line-items' && init?.method === 'POST') {
      const body = (init as { body?: Record<string, unknown> }).body as Record<string, unknown>;
      return Promise.resolve({
        lineItem: {
          id: 'line-new',
          name: 'Catalog Widget',
          productId: 'prod-1',
          quantity: String(body['quantity'] ?? '1'),
          unitPrice: '100',
          discountRate: String(body['discountRate'] ?? 0),
          taxRate: String(body['taxRate'] ?? 0),
          lineTotal: '200',
          currency: 'USD',
        },
      });
    }
    if (url.startsWith('/deals/deal-1/line-items/') && init?.method === 'DELETE') {
      return Promise.resolve({ ok: true });
    }
    if (url === '/deals/deal-1/history') {
      return Promise.resolve([
        {
          id: 'h-1',
          fromStageName: null,
          toStageName: 'Discovery',
          enteredAt: new Date().toISOString(),
          exitedAt: null,
          durationSeconds: null,
        },
      ]);
    }
    if (url === '/deals/deal-1/line-items') return Promise.resolve(overrides?.lineItems ?? []);
    if (url === '/products') {
      return Promise.resolve(
        overrides?.products ?? [
          {
            id: 'prod-1',
            name: 'Catalog Widget',
            sku: 'W-1',
            unitPrice: '100',
            currency: 'USD',
            taxRate: '0',
            isActive: true,
          },
        ],
      );
    }
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
    if (url.startsWith('/custom-fields')) return Promise.resolve([]);
    if (url === '/users') return Promise.resolve({ users: [] });
    if (url.startsWith('/accounts')) return Promise.resolve({ accounts: [] });
    if (url.startsWith('/contacts')) return Promise.resolve({ contacts: [] });
    if (url.includes('/stage')) return Promise.resolve({ deal: DEAL, changed: true });
    if (url === '/deals/deal-1' && init?.method === 'DELETE') {
      overrides?.onDelete?.();
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({});
  });
}

function renderDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DealDetailPage />
    </QueryClientProvider>,
  );
}

describe('DealDetailPage', () => {
  beforeEach(() => {
    mockApi.mockReset();
    mockNotify.mockReset();
    mockNavigate.mockReset();
    setupApi();
  });

  it('renders the header, stepper, forecast, history, and line items', async () => {
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'Acme Expansion' })).toBeInTheDocument();
    const stepper = await screen.findByRole('group', { name: 'Deal stages' });
    expect(within(stepper).getByRole('button', { name: /Discovery/ })).toBeInTheDocument();
    expect(screen.getByText(/Weighted/)).toBeInTheDocument();
    expect(screen.getByText('No products attached.')).toBeInTheDocument();
    expect(
      screen.getByText((_, el) => el?.textContent === 'Created → Discovery'),
    ).toBeInTheDocument();
  });

  it('moves through an open stage directly', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('heading', { name: 'Acme Expansion' });

    const stepper = screen.getByRole('group', { name: 'Deal stages' });
    await user.click(within(stepper).getByRole('button', { name: /Proposal/ }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/deals/deal-1/stage',
        expect.objectContaining({
          body: expect.objectContaining({ stageId: 'stage-proposal' }),
        }),
      ),
    );
    await waitFor(() => expect(mockNotify).toHaveBeenCalledWith('success', 'Deal stage updated'));
  });

  it('gates Closed Lost behind a required reason', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('heading', { name: 'Acme Expansion' });

    const stepper = screen.getByRole('group', { name: 'Deal stages' });
    await user.click(within(stepper).getByRole('button', { name: /Closed Lost/ }));

    expect(await screen.findByText('Close as lost')).toBeInTheDocument();
    expect(mockApi).not.toHaveBeenCalledWith('/deals/deal-1/stage', expect.anything());

    const confirm = screen.getByRole('button', { name: 'Move to lost' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Loss reason'), 'No budget');
    await user.click(confirm);

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/deals/deal-1/stage',
        expect.objectContaining({
          body: expect.objectContaining({ stageId: 'stage-lost', lossReason: 'No budget' }),
        }),
      ),
    );
  });

  it('confirms Closed Won explicitly when no line items exist', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('heading', { name: 'Acme Expansion' });

    const stepper = screen.getByRole('group', { name: 'Deal stages' });
    await user.click(within(stepper).getByRole('button', { name: /Closed Won/ }));

    expect(await screen.findByText('Close as won')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm won' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/deals/deal-1/stage',
        expect.objectContaining({ body: expect.objectContaining({ stageId: 'stage-won' }) }),
      ),
    );
  });

  it('saves inline edits through PATCH', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('heading', { name: 'Acme Expansion' });

    const editButton = screen.getAllByTitle('Click to edit')[0]!;
    await user.click(editButton);
    const input = screen.getByDisplayValue('Acme Expansion');
    await user.clear(input);
    await user.type(input, 'Acme Expansion Plus');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/deals/deal-1',
        expect.objectContaining({
          method: 'PATCH',
          body: expect.objectContaining({ name: 'Acme Expansion Plus' }),
        }),
      ),
    );
  });

  it('deletes with confirmation and navigates back', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('heading', { name: 'Acme Expansion' });

    await user.click(screen.getByRole('button', { name: 'Delete deal' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete deal' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: '/deals' }));
  });

  it('adds a catalog line item through the form', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('heading', { name: 'Acme Expansion' });
    await screen.findByText('No products attached.');

    const productSelect = screen.getByLabelText('Product') as HTMLSelectElement;
    await user.selectOptions(productSelect, 'prod-1');
    await user.click(screen.getByRole('button', { name: 'Add line item' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/deals/deal-1/line-items',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ productId: 'prod-1', quantity: 1 }),
        }),
      ),
    );
  });

  it('removes an existing line item', async () => {
    const user = userEvent.setup();
    setupApi({
      lineItems: [
        {
          id: 'line-1',
          name: 'Catalog Widget',
          productId: 'prod-1',
          quantity: '2',
          unitPrice: '100',
          discountRate: '0',
          taxRate: '0',
          lineTotal: '200',
          currency: 'USD',
        },
      ],
    });
    renderDetail();
    await screen.findByRole('heading', { name: 'Acme Expansion' });
    await screen.findByText('Catalog Widget');

    await user.click(screen.getByRole('button', { name: 'Remove Catalog Widget' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/deals/deal-1/line-items/line-1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });
});
