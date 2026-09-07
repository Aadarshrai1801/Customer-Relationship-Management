import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WelcomePage } from './welcome';

const mockApi = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: (...args: unknown[]) => mockApi(...args),
  hasScope: () => true,
  API_URL: 'http://localhost:3001',
}));

vi.mock('../lib/providers', () => ({
  useAuth: () => ({
    user: { id: 'u-1', name: 'Alice Owner', role: { permissions: { scopes: ['*'] } } },
    org: { id: 'org-1', name: 'Acme Org', slug: 'acme' },
  }),
}));

vi.mock('../components/toast', () => ({
  useToast: () => ({ notify: vi.fn() }),
}));

function setupApi(status: unknown) {
  mockApi.mockImplementation((url: string) => {
    if (url === '/onboarding/status') return Promise.resolve(status);
    return Promise.reject(new Error(`unexpected api call ${url}`));
  });
}

const INCOMPLETE = {
  steps: [
    {
      key: 'team',
      label: 'Invite your team',
      description: 'd1',
      done: false,
      link: '/settings/users',
    },
    {
      key: 'contact',
      label: 'Add your first contact',
      description: 'd2',
      done: true,
      link: '/contacts',
    },
  ],
  doneCount: 1,
  total: 2,
  complete: false,
};

const COMPLETE = {
  steps: [
    {
      key: 'team',
      label: 'Invite your team',
      description: 'd1',
      done: true,
      link: '/settings/users',
    },
  ],
  doneCount: 1,
  total: 1,
  complete: true,
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WelcomePage />
    </QueryClientProvider>,
  );
}

describe('WelcomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders progress with done badges and action links', async () => {
    setupApi(INCOMPLETE);
    renderPage();
    await screen.findByRole('heading', { name: 'Get started' });
    expect(await screen.findByText('1 of 2 steps done')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute(
      'aria-valuenow',
      '50',
    );
    expect(screen.getByText('done', { selector: 'span' })).toBeInTheDocument();
    const step = screen.getByRole('listitem', { name: 'Step Invite your team' });
    expect(step).toBeInTheDocument();
  });

  it('celebrates completion', async () => {
    setupApi(COMPLETE);
    renderPage();
    expect(await screen.findByText('Setup complete — nice work.')).toBeInTheDocument();
  });
});
