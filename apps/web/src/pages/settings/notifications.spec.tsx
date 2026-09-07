import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationPreferencesPage } from './notifications';

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

function setupApi(prefs: Record<string, string[]> = {}) {
  mockApi.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/notifications/preferences' && init?.method === 'POST') {
      const body = (init as { body?: Record<string, unknown> }).body as {
        type: string;
        channels: string[];
      };
      return Promise.resolve({ type: body.type, channels: body.channels });
    }
    if (url === '/notifications/preferences') return Promise.resolve(prefs);
    return Promise.reject(new Error(`unexpected api call ${url}`));
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NotificationPreferencesPage />
    </QueryClientProvider>,
  );
}

describe('NotificationPreferencesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupApi();
  });

  it('renders all channels on by default', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Notifications' });
    const mentionEmail = (await screen.findByLabelText('Mentions Email')) as HTMLInputElement;
    expect(mentionEmail.checked).toBe(true);
  });

  it('reflects stored preferences and saves toggles', async () => {
    setupApi({ mention: ['inapp'] });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Notifications' });

    const mentionEmail = (await screen.findByLabelText('Mentions Email')) as HTMLInputElement;
    expect(mentionEmail.checked).toBe(false);

    await user.click(mentionEmail);
    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/notifications/preferences',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ type: 'mention', channels: ['inapp', 'email'] }),
        }),
      ),
    );
  });
});
