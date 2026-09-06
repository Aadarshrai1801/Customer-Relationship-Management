import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LeadsListPage } from './leads-list';

const mockApi = vi.fn();
const mockNavigate = vi.fn();
const mockNotify = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
}));

vi.mock('../../lib/api', () => ({
  api: (...args: unknown[]) => mockApi(...args),
  hasScope: () => true,
  API_URL: 'http://localhost:3001',
}));

vi.mock('../../lib/providers', () => ({
  useAuth: () => ({
    user: { id: 'u-1', name: 'Alice Rep', role: { permissions: { scopes: ['*'] } } },
    org: { id: 'org-1', name: 'Acme Org', slug: 'acme' },
  }),
}));

vi.mock('../../components/toast', () => ({
  useToast: () => ({ notify: mockNotify }),
}));

describe('LeadsListPage', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    mockApi.mockReset();
    mockNavigate.mockReset();
    mockNotify.mockReset();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  it('renders leads list with items and status pills', async () => {
    mockApi.mockImplementation((url: string) => {
      if (url.includes('/custom-fields')) return Promise.resolve([]);
      if (url.includes('/users')) return Promise.resolve({ users: [] });
      if (url.includes('/leads')) {
        return Promise.resolve({
          items: [
            {
              id: 'lead-1',
              name: 'Sarah Connor',
              company: 'Cyberdyne Systems',
              email: 'sarah@example.com',
              phone: '555-0100',
              status: 'new',
              source: 'website',
              owner: { id: 'u-1', name: 'Alice Rep' },
              createdAt: new Date().toISOString(),
              customFields: {},
              computedFields: {},
            },
          ],
          total: 1,
          nextCursor: null,
        });
      }
      return Promise.resolve({});
    });

    render(
      <QueryClientProvider client={queryClient}>
        <LeadsListPage />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Sarah Connor')).toBeInTheDocument();
    expect(screen.getByText('Cyberdyne Systems')).toBeInTheDocument();
    expect(screen.getByText('sarah@example.com')).toBeInTheDocument();
    expect(screen.getByText('NEW')).toBeInTheDocument();
  });

  it('opens create lead modal and submits new lead', async () => {
    const user = userEvent.setup();

    mockApi.mockImplementation((url: string, opts?: { method?: string; body?: unknown }) => {
      if (url.includes('/custom-fields')) return Promise.resolve([]);
      if (url.includes('/users')) return Promise.resolve({ users: [] });
      if (opts?.method === 'POST' && url === '/leads') {
        return Promise.resolve({
          lead: {
            id: 'lead-created-1',
            name: 'John Doe',
            email: 'john@doe.com',
            status: 'new',
            source: 'website',
          },
          deduplicated: false,
        });
      }
      if (url.includes('/leads')) {
        return Promise.resolve({ items: [], total: 0, nextCursor: null });
      }
      return Promise.resolve({});
    });

    render(
      <QueryClientProvider client={queryClient}>
        <LeadsListPage />
      </QueryClientProvider>,
    );

    // Click + New Lead
    const newLeadBtn = await screen.findByRole('button', { name: /\+ New Lead/i });
    await user.click(newLeadBtn);

    // Modal opens
    expect(await screen.findByText('Create New Lead')).toBeInTheDocument();

    // Fill form
    await user.type(screen.getByLabelText(/Full \/ Display Name/i), 'John Doe');
    await user.type(screen.getByLabelText(/Email Address/i), 'john@doe.com');

    // Submit
    await user.click(screen.getByRole('button', { name: 'Create Lead' }));

    await waitFor(() => {
      expect(mockApi).toHaveBeenCalledWith(
        '/leads',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({
            email: 'john@doe.com',
            name: 'John Doe',
          }),
        }),
      );
    });

    expect(mockNotify).toHaveBeenCalledWith('success', expect.stringContaining('John Doe'));
  });
});
