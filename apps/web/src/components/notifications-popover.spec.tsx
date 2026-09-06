import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationsPopover } from './notifications-popover';

const mockApi = vi.fn();
const mockNavigate = vi.fn();
const mockNotify = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('../lib/api', () => ({
  api: (...args: unknown[]) => mockApi(...args),
  hasScope: () => true,
}));

vi.mock('../lib/providers', () => ({
  useAuth: () => ({
    user: { id: 'u-1', name: 'Alice Rep', role: { permissions: { scopes: ['*'] } } },
    org: { id: 'org-1', name: 'Acme Org' },
  }),
}));

vi.mock('./toast', () => ({
  useToast: () => ({ notify: mockNotify }),
}));

describe('NotificationsPopover', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    mockApi.mockReset();
    mockNavigate.mockReset();
    mockNotify.mockReset();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  it('renders unread badge and opens notifications popover on click', async () => {
    const user = userEvent.setup();

    mockApi.mockImplementation((url: string) => {
      if (url.includes('/notifications')) {
        return Promise.resolve({
          items: [
            {
              id: 'notif-1',
              title: 'New Lead Assigned: Wayne Enterprises',
              body: 'Lead Wayne Enterprises was assigned to you.',
              link: '/leads/lead-123',
              readAt: null,
              createdAt: new Date().toISOString(),
            },
          ],
          unreadCount: 1,
        });
      }
      return Promise.resolve({});
    });

    render(
      <QueryClientProvider client={queryClient}>
        <NotificationsPopover />
      </QueryClientProvider>,
    );

    // Bell button with unread count badge
    const bellBtn = await screen.findByRole('button', { name: /Notifications \(1 unread\)/i });
    expect(bellBtn).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();

    // Click bell button to open popover
    await user.click(bellBtn);

    expect(await screen.findByRole('dialog', { name: /Notifications popover/i })).toBeInTheDocument();
    expect(screen.getByText('New Lead Assigned: Wayne Enterprises')).toBeInTheDocument();
    expect(screen.getByText('Lead Wayne Enterprises was assigned to you.')).toBeInTheDocument();
    expect(screen.getByText('Mark all read')).toBeInTheDocument();
  });

  it('marks notification as read and navigates to link when clicked', async () => {
    const user = userEvent.setup();

    mockApi.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PATCH' && url === '/notifications/notif-1/read') {
        return Promise.resolve({ ok: true });
      }
      if (url.includes('/notifications')) {
        return Promise.resolve({
          items: [
            {
              id: 'notif-1',
              title: 'New Lead Assigned: Stark Industries',
              body: 'Lead Stark Industries was assigned to you.',
              link: '/leads/lead-456',
              readAt: null,
              createdAt: new Date().toISOString(),
            },
          ],
          unreadCount: 1,
        });
      }
      return Promise.resolve({});
    });

    render(
      <QueryClientProvider client={queryClient}>
        <NotificationsPopover />
      </QueryClientProvider>,
    );

    const bellBtn = await screen.findByRole('button', { name: /Notifications/i });
    await user.click(bellBtn);

    const notifItem = await screen.findByText('New Lead Assigned: Stark Industries');
    await user.click(notifItem);

    await waitFor(() => {
      expect(mockApi).toHaveBeenCalledWith('/notifications/notif-1/read', { method: 'PATCH' });
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/leads/lead-456' });
    });
  });

  it('marks all notifications as read when clicking Mark all read', async () => {
    const user = userEvent.setup();

    mockApi.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST' && url === '/notifications/read-all') {
        return Promise.resolve({ count: 2 });
      }
      if (url.includes('/notifications')) {
        return Promise.resolve({
          items: [
            {
              id: 'notif-1',
              title: 'Lead 1',
              body: 'Lead 1 assigned',
              link: '/leads/1',
              readAt: null,
              createdAt: new Date().toISOString(),
            },
          ],
          unreadCount: 1,
        });
      }
      return Promise.resolve({});
    });

    render(
      <QueryClientProvider client={queryClient}>
        <NotificationsPopover />
      </QueryClientProvider>,
    );

    const bellBtn = await screen.findByRole('button', { name: /Notifications/i });
    await user.click(bellBtn);

    const markAllBtn = await screen.findByRole('button', { name: /Mark all read/i });
    await user.click(markAllBtn);

    await waitFor(() => {
      expect(mockApi).toHaveBeenCalledWith('/notifications/read-all', { method: 'POST' });
    });
  });
});
