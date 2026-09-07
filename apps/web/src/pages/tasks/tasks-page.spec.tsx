import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TasksPage } from './tasks-page';

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

const TASK = {
  id: 'task-1',
  owner: { id: 'u-1', name: 'Alice Owner' },
  ownerId: 'u-1',
  contact: null,
  account: null,
  deal: null,
  title: 'Follow up on proposal',
  description: null,
  status: 'open',
  priority: 'normal',
  dueAt: new Date(Date.now() + 86400000).toISOString(),
  remindAt: null,
  reminderSentAt: null,
  completedAt: null,
  overdue: false,
  reminderDue: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function setupApi(overrides?: { tasks?: unknown[]; activities?: unknown[] }) {
  mockApi.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/tasks/reminders/dispatch') {
      return Promise.resolve({ ownersNotified: 1, tasksIncluded: 2 });
    }
    if (url.endsWith('/complete')) {
      return Promise.resolve({ task: { ...TASK, status: 'completed' }, changed: true });
    }
    if (url.startsWith('/tasks') && init?.method === 'POST') {
      const body = (init as { body?: Record<string, unknown> }).body ?? {};
      return Promise.resolve({ task: { ...TASK, ...(body as object), id: 'task-new' } });
    }
    if (url.startsWith('/tasks/') && init?.method === 'DELETE') {
      return Promise.resolve({ ok: true });
    }
    if (url.startsWith('/tasks'))
      return Promise.resolve({ tasks: overrides?.tasks ?? [TASK], nextCursor: null });
    if (url.startsWith('/activities') && init?.method === 'POST') {
      return Promise.resolve({
        activity: { id: 'act-1', type: 'call', subject: 'Discovery call' },
      });
    }
    if (url.startsWith('/activities')) {
      return Promise.resolve({ activities: overrides?.activities ?? [], nextCursor: null });
    }
    return Promise.reject(new Error(`unexpected api call ${url}`));
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TasksPage />
    </QueryClientProvider>,
  );
}

describe('TasksPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupApi();
  });

  it('renders the task list with filters and recent activity', async () => {
    setupApi({
      activities: [
        {
          id: 'act-9',
          type: 'call',
          subject: 'Discovery call',
          body: null,
          occurredAt: new Date().toISOString(),
          provider: null,
          syncStatus: 'active',
          conflictFlag: false,
        },
      ],
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Tasks', level: 1 });
    expect(await screen.findByText('Follow up on proposal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Overdue' })).toBeInTheDocument();
    expect(await screen.findByText('Discovery call')).toBeInTheDocument();
  });

  it('creates a task through the modal', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Follow up on proposal');

    await user.click(screen.getByRole('button', { name: '+ New Task' }));
    await user.type(screen.getByLabelText('Title'), 'Send contract');
    await user.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/tasks',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ title: 'Send contract' }),
        }),
      ),
    );
  });

  it('completes a task from the list', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Follow up on proposal');

    const row = screen.getByRole('listitem', { name: 'Task Follow up on proposal' });
    await user.click(within(row).getByRole('button', { name: 'Complete' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/tasks/task-1/complete',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('switches to the overdue filter', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Follow up on proposal');

    await user.click(screen.getByRole('button', { name: 'Overdue' }));

    await waitFor(() => expect(mockApi).toHaveBeenCalledWith('/tasks?overdue=true'));
  });

  it('logs an activity from the recent-activity form', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Tasks', level: 1 });

    await user.type(screen.getByLabelText('Subject'), 'Discovery call');
    await user.click(screen.getByRole('button', { name: 'Log activity' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/activities',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ type: 'call', subject: 'Discovery call' }),
        }),
      ),
    );
  });

  it('dispatches reminder digests on demand', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Tasks', level: 1 });

    await user.click(screen.getByRole('button', { name: 'Send digests' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/tasks/reminders/dispatch',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});
