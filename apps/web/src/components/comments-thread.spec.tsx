import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CommentsThread } from './comments-thread';

const mockApi = vi.fn();
const mockNotify = vi.fn();

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

vi.mock('./toast', () => ({
  useToast: () => ({ notify: mockNotify }),
}));

const COMMENT = {
  id: 'c-1',
  author: { id: 'u-1', name: 'Alice Owner' },
  authorId: 'u-1',
  entityType: 'deal',
  entityId: 'deal-1',
  body: 'Looks good to me',
  mentionedUsers: [{ id: 'u-2', name: 'Rita Rep', email: 'rita@example.test' }],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function setupApi(overrides?: { comments?: unknown[] }) {
  mockApi.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.startsWith('/comments') && init?.method === 'POST') {
      return Promise.resolve({ comment: COMMENT });
    }
    if (url.startsWith('/comments/') && init?.method === 'PATCH') {
      return Promise.resolve({ comment: COMMENT });
    }
    if (url.startsWith('/comments/') && init?.method === 'DELETE') {
      return Promise.resolve({ ok: true });
    }
    if (url.startsWith('/comments')) {
      return Promise.resolve({ comments: overrides?.comments ?? [COMMENT], nextCursor: null });
    }
    return Promise.reject(new Error(`unexpected api call ${url}`));
  });
}

function renderThread() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CommentsThread entityType="deal" entityId="deal-1" />
    </QueryClientProvider>,
  );
}

describe('CommentsThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupApi();
  });

  it('renders comments with mention targets', async () => {
    renderThread();
    expect(await screen.findByText('Looks good to me')).toBeInTheDocument();
    expect(screen.getByText(/Notified: rita@example.test/)).toBeInTheDocument();
  });

  it('posts a comment through the composer', async () => {
    const user = userEvent.setup();
    renderThread();
    await screen.findByText('Looks good to me');

    await user.type(screen.getByLabelText('Write a comment'), 'Ping @rita@example.test');
    await user.click(screen.getByRole('button', { name: 'Post comment' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/comments',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ body: 'Ping @rita@example.test' }),
        }),
      ),
    );
  });

  it('edits and deletes an own comment', async () => {
    const user = userEvent.setup();
    renderThread();
    await screen.findByText('Looks good to me');

    const row = screen.getByRole('listitem', { name: 'Comment by Alice Owner' });
    await user.click(within(row).getByRole('button', { name: 'Edit comment by Alice Owner' }));
    const editor = screen.getByLabelText('Edit comment');
    await user.clear(editor);
    await user.type(editor, 'Updated take');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/comments/c-1',
        expect.objectContaining({
          method: 'PATCH',
          body: expect.objectContaining({ body: 'Updated take' }),
        }),
      ),
    );

    await user.click(within(row).getByRole('button', { name: 'Delete comment by Alice Owner' }));
    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/comments/c-1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });

  it('shows an empty state when there are no comments', async () => {
    setupApi({ comments: [] });
    renderThread();
    expect(await screen.findByText('No comments yet.')).toBeInTheDocument();
  });
});
