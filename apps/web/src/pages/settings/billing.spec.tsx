import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BillingPage } from './billing';

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

const SUBSCRIPTION = {
  id: 'sub-1',
  plan: 'trial',
  seats: 1,
  status: 'active',
  unitPrice: 0,
  currency: 'USD',
  mrr: 0,
  activeUsers: 1,
  cycleStart: new Date().toISOString(),
  cycleEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
  provider: 'stub',
};

function setupApi(overrides?: { invoices?: unknown[] }) {
  mockApi.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/billing/subscription') return Promise.resolve({ ...SUBSCRIPTION });
    if (url === '/billing/seats/preview') {
      return Promise.resolve({
        plan: 'growth',
        previousPlan: 'trial',
        seats: 2,
        previousSeats: 1,
        seatDelta: 1,
        unitPrice: 30,
        currency: 'USD',
        daysRemainingInCycle: 30,
        proratedCharge: 60,
        newMrr: 60,
      });
    }
    if (url === '/billing/seats') {
      return Promise.resolve({ subscription: { ...SUBSCRIPTION }, invoice: null, charged: 60 });
    }
    if (url === '/billing/invoices') {
      return Promise.resolve(overrides?.invoices ?? []);
    }
    return Promise.reject(new Error(`unexpected api call ${url}`));
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BillingPage />
    </QueryClientProvider>,
  );
}

describe('BillingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupApi();
  });

  it('renders the subscription and empty invoices', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Billing' });
    expect(await screen.findByText('USD 0.00')).toBeInTheDocument();
    expect(screen.getByText('No invoices yet')).toBeInTheDocument();
  });

  it('previews prorated charges before confirming', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Billing' });
    await screen.findByText('USD 0.00');

    await user.selectOptions(screen.getByLabelText('Plan'), 'growth');
    const seats = screen.getByLabelText('Seats') as HTMLInputElement;
    await user.clear(seats);
    await user.type(seats, '2');

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/billing/seats/preview',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ plan: 'growth', seats: 2 }),
        }),
      ),
    );
    expect(await screen.findByText(/Charge of/)).toBeInTheDocument();
    expect(screen.getByText(/new MRR/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm change' }));
    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/billing/seats',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ plan: 'growth', seats: 2 }),
        }),
      ),
    );
  });

  it('lists invoices with amounts', async () => {
    setupApi({
      invoices: [
        {
          id: 'inv-1',
          number: 'INV-ABC123',
          amount: '60.00',
          currency: 'USD',
          status: 'paid',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    renderPage();
    expect(await screen.findByText('INV-ABC123')).toBeInTheDocument();
    expect(screen.getByText('USD 60.00')).toBeInTheDocument();
  });
});
