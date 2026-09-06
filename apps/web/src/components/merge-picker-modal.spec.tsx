import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MergePickerModal } from './merge-picker-modal';

const mockApi = vi.fn();

vi.mock('../lib/api', () => ({
  api: (...args: unknown[]) => mockApi(...args),
}));

vi.mock('./toast', () => ({
  useToast: () => ({ notify: vi.fn() }),
}));

describe('MergePickerModal', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    mockApi.mockReset();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  it('renders conflicting fields and requires explicit resolution choice', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();

    mockApi.mockResolvedValueOnce({
      winnerId: 'win-123',
      loserId: 'lose-456',
      fields: [
        { field: 'email', winner: 'winner@test.com', loser: 'loser@test.com', conflict: true },
        { field: 'title', winner: 'Director', loser: 'Director', conflict: false },
      ],
      tags: { winner: ['tag1'], loser: ['tag2'], merged: ['tag1', 'tag2'] },
      notesMoved: 3,
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MergePickerModal
          open={true}
          onOpenChange={vi.fn()}
          entityType="contact"
          primaryId="win-123"
          secondaryId="lose-456"
          primaryName="Winner Contact"
          secondaryName="Loser Contact"
          onSuccess={onSuccess}
        />
      </QueryClientProvider>,
    );

    // Wait for preview to load
    expect(await screen.findByText('Conflicting Fields (1) — Explicit Choice Required')).toBeInTheDocument();
    expect(screen.getByText('winner@test.com')).toBeInTheDocument();
    expect(screen.getByText('loser@test.com')).toBeInTheDocument();

    // Select secondary for email conflict
    const secondaryButtons = screen.getAllByRole('button', { name: 'Secondary' });
    await user.click(secondaryButtons[0]!);

    // Confirm button should be enabled
    const confirmButton = screen.getByRole('button', { name: /Confirm & Merge Records/i });
    expect(confirmButton).toBeEnabled();

    mockApi.mockResolvedValueOnce({ success: true });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(mockApi).toHaveBeenCalledWith('/contacts/win-123/merge', {
        method: 'POST',
        body: {
          loserId: 'lose-456',
          fieldChoices: { email: 'loser' },
        },
      });
      expect(onSuccess).toHaveBeenCalledWith('win-123');
    });
  });
});
