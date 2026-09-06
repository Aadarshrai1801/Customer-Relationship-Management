import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LeadDetailPage } from './lead-detail';

const mockApi = vi.fn();
const mockNavigate = vi.fn();
const mockNotify = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
  useParams: () => ({ id: 'lead-test-123' }),
}));

vi.mock('../../lib/api', () => ({
  api: (...args: unknown[]) => mockApi(...args),
  hasScope: () => true,
}));

vi.mock('../../lib/providers', () => ({
  useAuth: () => ({
    user: { id: 'u-1', name: 'Alice Rep', role: { permissions: { scopes: ['*'] } } },
    org: { id: 'org-1', name: 'Acme Org' },
  }),
}));

vi.mock('../../components/toast', () => ({
  useToast: () => ({ notify: mockNotify }),
}));

describe('LeadDetailPage', () => {
  let queryClient: QueryClient;

  const sampleLead = {
    id: 'lead-test-123',
    name: 'Bruce Wayne',
    firstName: 'Bruce',
    lastName: 'Wayne',
    email: 'bruce@wayneenterprises.com',
    phone: '555-BATMAN',
    company: 'Wayne Enterprises',
    title: 'CEO',
    status: 'new',
    source: 'website',
    utmSource: 'google',
    utmMedium: 'cpc',
    utmCampaign: 'dark-knight',
    notes: 'High net worth enterprise prospect.',
    customFields: {},
    computedFields: {},
    ownerId: 'u-1',
    owner: { id: 'u-1', name: 'Alice Rep' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    convertedAt: null,
    convertedContactId: null,
    convertedAccountId: null,
  };

  beforeEach(() => {
    mockApi.mockReset();
    mockNavigate.mockReset();
    mockNotify.mockReset();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  it('renders lead details and lifecycle progression stages', async () => {
    mockApi.mockImplementation((url: string) => {
      if (url === '/leads/lead-test-123') return Promise.resolve(sampleLead);
      if (url.includes('/assignment-history')) return Promise.resolve([]);
      if (url.includes('/custom-fields')) return Promise.resolve([]);
      if (url.includes('/users')) return Promise.resolve({ users: [] });
      return Promise.resolve({});
    });

    render(
      <QueryClientProvider client={queryClient}>
        <LeadDetailPage />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Bruce Wayne' })).toBeInTheDocument();
    expect(screen.getAllByText('bruce@wayneenterprises.com').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Wayne Enterprises').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Stage 1')).toBeInTheDocument();
    expect(screen.getByText('Stage 2')).toBeInTheDocument();
  });

  it('updates stage progression on click', async () => {
    const user = userEvent.setup();

    mockApi.mockImplementation((url: string, opts?: { method?: string; body?: unknown }) => {
      if (opts?.method === 'PATCH' && url === '/leads/lead-test-123') {
        return Promise.resolve({ ...sampleLead, status: 'contacted' });
      }
      if (url === '/leads/lead-test-123') return Promise.resolve(sampleLead);
      if (url.includes('/assignment-history')) return Promise.resolve([]);
      if (url.includes('/custom-fields')) return Promise.resolve([]);
      if (url.includes('/users')) return Promise.resolve({ users: [] });
      return Promise.resolve({});
    });

    render(
      <QueryClientProvider client={queryClient}>
        <LeadDetailPage />
      </QueryClientProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Bruce Wayne' });

    // Click "Contacted" stage button
    const contactedBtn = screen.getByRole('button', { name: /Contacted/i });
    await user.click(contactedBtn);

    await waitFor(() => {
      expect(mockApi).toHaveBeenCalledWith(
        '/leads/lead-test-123',
        expect.objectContaining({
          method: 'PATCH',
          body: { status: 'contacted' },
        }),
      );
    });
  });

  it('opens conversion modal and triggers lead conversion', async () => {
    const user = userEvent.setup();

    mockApi.mockImplementation((url: string, opts?: { method?: string; body?: unknown }) => {
      if (opts?.method === 'POST' && url === '/leads/lead-test-123/convert') {
        return Promise.resolve({
          lead: { ...sampleLead, status: 'converted', convertedAt: new Date().toISOString() },
          contact: { id: 'contact-new-1', name: 'Bruce Wayne', email: 'bruce@wayneenterprises.com' },
          account: { id: 'account-new-1', name: 'Wayne Enterprises' },
        });
      }
      if (url.includes('/accounts')) return Promise.resolve({ accounts: [] });
      if (url === '/leads/lead-test-123') return Promise.resolve(sampleLead);
      if (url.includes('/assignment-history')) return Promise.resolve([]);
      if (url.includes('/custom-fields')) return Promise.resolve([]);
      if (url.includes('/users')) return Promise.resolve({ users: [] });
      return Promise.resolve({});
    });

    render(
      <QueryClientProvider client={queryClient}>
        <LeadDetailPage />
      </QueryClientProvider>,
    );

    // Click Convert Lead
    const convertBtn = await screen.findByRole('button', { name: /Convert Lead/i });
    await user.click(convertBtn);

    // Modal is opened
    expect(await screen.findByText('Convert this qualified lead into a Contact and Account record.')).toBeInTheDocument();

    // Confirm conversion
    const confirmBtn = screen.getByRole('button', { name: 'Convert Lead' });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(mockApi).toHaveBeenCalledWith(
        '/leads/lead-test-123/convert',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });

    expect(mockNotify).toHaveBeenCalledWith('success', expect.stringContaining('Lead converted'));
  });
});
