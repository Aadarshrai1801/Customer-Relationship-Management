import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmailsPage } from './emails-page';

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

const INBOUND = {
  id: 'mail-1',
  owner: { id: 'u-1', name: 'Alice Owner' },
  ownerId: 'u-1',
  contact: { id: 'c-1', name: 'Emily Prospect' },
  account: null,
  deal: null,
  subject: 'Pricing question',
  body: 'What does it cost?',
  occurredAt: new Date().toISOString(),
  direction: 'inbound',
  senderEmail: 'emily@example.test',
  recipientEmails: ['alice@acme.test'],
  provider: 'gmail',
  externalId: 'msg-1',
  syncStatus: 'active',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const TEMPLATE = {
  id: 'tpl-1',
  name: 'Intro',
  subject: 'Hi {{contactName}}',
  body: 'Hi {{contactName}}, this is {{ownerName}}.',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const SUGGESTION = {
  ...INBOUND,
  id: 'mail-2',
  contact: null,
  senderEmail: 'stranger@example.test',
  subject: 'Cold hello',
};

function setupApi(overrides?: { log?: unknown[]; templates?: unknown[]; suggestions?: unknown[] }) {
  mockApi.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/emails/send') {
      return Promise.resolve({ activity: { ...INBOUND, direction: 'outbound' }, messageId: 'm-1' });
    }
    if (url === '/emails/sync') {
      return Promise.resolve({ activity: SUGGESTION, created: true, changed: true });
    }
    if (url.startsWith('/emails/suggestions/') && url.endsWith('/convert')) {
      return Promise.resolve({ contact: { id: 'c-9' }, activity: SUGGESTION });
    }
    if (url.startsWith('/emails/suggestions')) {
      return Promise.resolve({ suggestions: overrides?.suggestions ?? [], nextCursor: null });
    }
    if (url === '/email-templates' && init?.method === 'POST') {
      return Promise.resolve({ template: TEMPLATE });
    }
    if (url.startsWith('/email-templates/') && init?.method === 'DELETE') {
      return Promise.resolve({ ok: true });
    }
    if (url.startsWith('/email-templates')) {
      return Promise.resolve(overrides?.templates ?? [TEMPLATE]);
    }
    if (url.startsWith('/activities')) {
      return Promise.resolve({ activities: overrides?.log ?? [INBOUND], nextCursor: null });
    }
    return Promise.reject(new Error(`unexpected api call ${url}`));
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <EmailsPage />
    </QueryClientProvider>,
  );
}

describe('EmailsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupApi();
  });

  it('renders the log, templates, and convert flow for unmatched senders', async () => {
    setupApi({ suggestions: [SUGGESTION] });
    renderPage();
    await screen.findByRole('heading', { name: 'Emails', level: 1 });
    expect(await screen.findByText('Pricing question')).toBeInTheDocument();
    expect(screen.getByText('Intro')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Log as new contact' }));
    await user.type(screen.getByLabelText('Contact name'), 'Sam Stranger');
    await user.click(screen.getByRole('button', { name: 'Create contact' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/emails/suggestions/mail-2/convert',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ name: 'Sam Stranger' }),
        }),
      ),
    );
  });

  it('sends a free-form email through compose', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Emails', level: 1 });

    await user.click(screen.getByRole('button', { name: '+ Compose' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('To'), 'buyer@acme.test');
    await user.type(within(dialog).getByLabelText('Subject'), 'Quick intro');
    await user.type(within(dialog).getByLabelText('Body'), 'Nice meeting you.');
    await user.click(within(dialog).getByRole('button', { name: 'Send email' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/emails/send',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ to: 'buyer@acme.test', subject: 'Quick intro' }),
        }),
      ),
    );
  });

  it('creates a template from the form', async () => {
    const user = userEvent.setup();
    setupApi({ templates: [] });
    renderPage();
    await screen.findByRole('heading', { name: 'Emails', level: 1 });
    expect(await screen.findByText('No templates yet.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Template name'), 'Follow-up');
    await user.type(screen.getByPlaceholderText('Hi {{contactName}}'), 'Checking in');
    await user.type(screen.getByLabelText('Body'), 'Hi {{contactName}}');
    await user.click(screen.getByRole('button', { name: 'Create template' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/email-templates',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ name: 'Follow-up' }),
        }),
      ),
    );
  });

  it('syncs a test inbound email from the console', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Emails', level: 1 });

    await user.type(screen.getByLabelText('Sender email'), 'prospect@example.test');
    await user.click(screen.getByRole('button', { name: 'Sync test email' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/emails/sync',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ from: 'prospect@example.test' }),
        }),
      ),
    );
  });

  it('filters the log by direction', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Emails', level: 1 });

    await user.click(screen.getByRole('button', { name: 'Outbound' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith('/activities?type=email&limit=50&direction=outbound'),
    );
  });
});
