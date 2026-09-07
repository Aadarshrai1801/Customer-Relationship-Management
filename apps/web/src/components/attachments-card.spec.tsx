import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AttachmentsCard } from './attachments-card';

const mockApi = vi.fn();
const mockNotify = vi.fn();
const mockFetch = vi.fn();

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

const FILE = {
  id: 'a-1',
  owner: { id: 'u-1', name: 'Alice Owner' },
  ownerId: 'u-1',
  entityType: 'deal',
  entityId: 'deal-1',
  filename: 'proposal.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function setupApi(overrides?: { files?: unknown[] }) {
  mockApi.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.startsWith('/attachments/') && init?.method === 'DELETE') {
      return Promise.resolve({ ok: true });
    }
    if (url.startsWith('/attachments')) {
      return Promise.resolve({ attachments: overrides?.files ?? [FILE], nextCursor: null });
    }
    return Promise.reject(new Error(`unexpected api call ${url}`));
  });
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ attachment: FILE }),
  });
}

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AttachmentsCard entityType="deal" entityId="deal-1" />
    </QueryClientProvider>,
  );
}

describe('AttachmentsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupApi();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders files with download links and sizes', async () => {
    renderCard();
    expect(await screen.findByText('proposal.pdf')).toBeInTheDocument();
    expect(screen.getByText(/2.0 KB/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'proposal.pdf' });
    expect(link.getAttribute('href')).toContain('/v1/attachments/a-1/download');
  });

  it('uploads a chosen file as multipart', async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByText('proposal.pdf');

    const input = screen.getByLabelText('Choose files to upload') as HTMLInputElement;
    const file = new File(['deal-notes'], 'notes.txt', { type: 'text/plain' });
    await user.upload(input, file);

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const [url, init] = mockFetch.mock.calls[0] as [string, { method: string; body: FormData }];
    expect(url).toContain('/v1/attachments/upload');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('entityType')).toBe('deal');
    expect(init.body.get('entityId')).toBe('deal-1');
    expect((init.body.get('file') as File).name).toBe('notes.txt');
  });

  it('surfaces upload failures inline', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        message: 'Files of type .exe are not accepted',
        code: 'FILE_TYPE_INVALID',
      }),
    });
    const user = userEvent.setup();
    renderCard();
    await screen.findByText('proposal.pdf');

    const input = screen.getByLabelText('Choose files to upload') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'run.exe', { type: 'application/x-msdownload' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not accepted/);
  });

  it('deletes an attachment', async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByText('proposal.pdf');

    await user.click(screen.getByRole('button', { name: 'Delete attachment proposal.pdf' }));
    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        '/attachments/a-1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });
});
