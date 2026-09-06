import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InlineEdit } from './inline-edit';

describe('InlineEdit component', () => {
  it('renders initial value and switches to edit mode on click', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(<InlineEdit label="Full Name" value="Alice Johnson" onSave={onSave} />);

    expect(screen.getByText('Alice Johnson')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    // Click to enter edit mode
    await user.click(screen.getByRole('button', { name: /Alice Johnson/i }));

    const input = screen.getByRole('textbox');
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue('Alice Johnson');

    // Type and save
    await user.clear(input);
    await user.type(input, 'Alice Smith');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('Alice Smith');
    });
  });

  it('cancels edit mode without saving when cancel button is clicked', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(<InlineEdit label="Title" value="Engineer" onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: /Engineer/i }));
    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'Director');

    await user.click(screen.getByRole('button', { name: '✕' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Engineer')).toBeInTheDocument();
  });

  it('renders non-editable display when readOnly is true', () => {
    const onSave = vi.fn();
    render(<InlineEdit label="Email" value="alice@test.com" readOnly onSave={onSave} />);

    expect(screen.getByText('alice@test.com')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
