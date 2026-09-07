import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkflowsPage } from './workflows';

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

const FLOW = {
  id: 'wf-1',
  owner: { id: 'u-1', name: 'Alice Owner' },
  name: 'Welcome tasks',
  isActive: true,
  trigger: { kind: 'record.created', entity: 'contact' },
  conditions: [],
  actions: [{ type: 'create_task', title: 'Welcome' }],
  maxRuns: 5,
};

function setupApi(overrides?: { flows?: unknown[]; runs?: unknown[] }) {
  mockApi.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/workflows' && init?.method === 'POST') {
      const body = (init as { body?: Record<string, unknown> }).body ?? {};
      return Promise.resolve({ workflow: { ...FLOW, ...(body as object), id: 'wf-new' } });
    }
    if (url.includes('/runs')) {
      return Promise.resolve({ runs: overrides?.runs ?? [], nextCursor: null });
    }
    if (url.startsWith('/workflows/') && (init?.method === 'PATCH' || init?.method === 'DELETE')) {
      return Promise.resolve(init?.method === 'PATCH' ? { workflow: FLOW } : { ok: true });
    }
    if (url.startsWith('/workflows')) {
      return Promise.resolve({ workflows: overrides?.flows ?? [FLOW], nextCursor: null });
    }
    return Promise.reject(new Error(`unexpected api call ${url}`));
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkflowsPage />
    </QueryClientProvider>,
  );
}

describe('WorkflowsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupApi();
  });

  it('renders rules with trigger summaries and run viewer', async () => {
    setupApi({
      runs: [
        {
          id: 'r-1',
          status: 'success',
          error: null,
          actionResults: [],
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Workflows' });
    expect(await screen.findByText('Welcome tasks')).toBeInTheDocument();
    expect(screen.getByText('record.created contact')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Welcome tasks' }));
    expect(await screen.findByText('success')).toBeInTheDocument();
  });

  it('creates a workflow from the form', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Workflows' });

    await user.click(screen.getByRole('button', { name: '+ New Workflow' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Workflow name'), 'Deal nudges');
    await user.selectOptions(within(dialog).getByLabelText('Trigger'), 'field.changed');
    await user.selectOptions(within(dialog).getByLabelText('Entity'), 'deal');
    await user.clear(within(dialog).getByLabelText('Changed field'));
    await user.type(within(dialog).getByLabelText('Changed field'), 'probability');
    await user.type(within(dialog).getByLabelText('Task title'), 'Check the numbers');
    await user.click(within(dialog).getByRole('button', { name: 'Create Workflow' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/workflows',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({
            name: 'Deal nudges',
            trigger: expect.objectContaining({
              kind: 'field.changed',
              entity: 'deal',
              field: 'probability',
            }),
          }),
        }),
      ),
    );
  });

  it('pauses a workflow', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Welcome tasks');

    await user.click(screen.getByRole('button', { name: 'Pause workflow Welcome tasks' }));
    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/workflows/wf-1',
        expect.objectContaining({
          method: 'PATCH',
          body: expect.objectContaining({ isActive: false }),
        }),
      ),
    );
  });
});
