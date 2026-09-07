import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SequencesPage } from './sequences-page';

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

const SEQUENCE = {
  id: 'seq-1',
  name: 'Post-demo drip',
  isActive: true,
  steps: [{ kind: 'send_email' }],
  enrolled: 2,
};

function setupApi(overrides?: { sequences?: unknown[]; enrollments?: unknown[] }) {
  mockApi.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/sequences' && init?.method === 'POST') {
      const body = (init as { body?: Record<string, unknown> }).body ?? {};
      return Promise.resolve({ sequence: { ...SEQUENCE, ...(body as object), id: 'seq-new' } });
    }
    if (url.startsWith('/sequences/') && url.endsWith('/enrollments') && init?.method === 'POST') {
      return Promise.resolve({ enrollment: { id: 'enr-1' } });
    }
    if (url.includes('/enrollments/') && init?.method === 'POST') {
      return Promise.resolve({ enrollment: { id: 'enr-1', status: 'paused' } });
    }
    if (url.includes('/enrollments')) {
      return Promise.resolve(overrides?.enrollments ?? []);
    }
    if (url === '/sequences') {
      return Promise.resolve(overrides?.sequences ?? [SEQUENCE]);
    }
    if (url === '/contacts?limit=200') return Promise.resolve({ contacts: [] });
    return Promise.reject(new Error(`unexpected api call ${url}`));
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SequencesPage />
    </QueryClientProvider>,
  );
}

describe('SequencesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupApi();
  });

  it('renders sequences with enrollment counts', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Sequences' });
    expect(await screen.findByText('Post-demo drip')).toBeInTheDocument();
    expect(screen.getByText('2 enrolled')).toBeInTheDocument();
  });

  it('creates a sequence from the builder', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Post-demo drip');

    await user.click(screen.getByRole('button', { name: '+ New Sequence' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Re-engage');
    await user.type(within(dialog).getByLabelText('Subject'), 'Miss you');
    await user.type(within(dialog).getByLabelText('Body'), 'Come back soon.');
    await user.click(within(dialog).getByRole('button', { name: 'Create Sequence' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/sequences',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({
            name: 'Re-engage',
            steps: [{ kind: 'send_email', subject: 'Miss you', body: 'Come back soon.' }],
          }),
        }),
      ),
    );
  });

  it('shows enrollments with pause controls', async () => {
    setupApi({
      enrollments: [
        {
          id: 'enr-1',
          contact: { id: 'c-1', name: 'Cadence', email: 'c@x.test' },
          status: 'active',
          currentStep: 0,
        },
      ],
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Post-demo drip');

    await user.click(screen.getByRole('button', { name: 'Post-demo drip' }));
    expect(await screen.findByText('Cadence')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });
});
