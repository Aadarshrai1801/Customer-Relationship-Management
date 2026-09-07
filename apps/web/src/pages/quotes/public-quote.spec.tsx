import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PublicQuotePage } from './public-quote';

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ token: 'tok-123' }),
}));

const QUOTE = {
  id: 'q-1',
  number: 'Q-ABC123',
  lines: [{ name: 'Consulting Day', quantity: '2', unitPrice: '1000', lineTotal: '1980' }],
  subtotal: 1800,
  discountTotal: 90,
  taxTotal: 171,
  total: 1881,
  currency: 'USD',
  validUntil: new Date(Date.now() + 86400000).toISOString(),
  status: 'sent',
  signature: null,
  expired: false,
};

function renderPage(quote: unknown = QUOTE) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => quote,
  }));
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={queryClient}>
      <PublicQuotePage />
    </QueryClientProvider>,
  );
  return fetchMock;
}

describe('PublicQuotePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders totals and the decision form for sent quotes', async () => {
    renderPage();
    expect(await screen.findByText(/Q-ABC123/)).toBeInTheDocument();
    expect(screen.getAllByText(/USD 1,881\.00/)[0]).toBeInTheDocument();
    expect(screen.getByLabelText('Your name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept & sign' })).toBeInTheDocument();
  });

  it('shows the signature once accepted', async () => {
    renderPage({
      ...QUOTE,
      status: 'accepted',
      signature: { name: 'Quincy', at: new Date().toISOString() },
    });
    expect(await screen.findByText(/Signed by Quincy/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept & sign' })).not.toBeInTheDocument();
  });
});
