import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => () => undefined,
}));

vi.mock('../lib/providers', () => ({
  useAuth: () => ({ setSession: vi.fn() }),
}));

vi.mock('../components/toast', () => ({
  useToast: () => ({ notify: vi.fn() }),
}));

const loginMock = vi.fn();

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: (...args: unknown[]) => loginMock(...args),
  };
});

import { LoginPage } from './login';

describe('login page', () => {
  beforeEach(() => {
    loginMock.mockReset();
  });

  it('shows client-side validation before calling the API', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('submits credentials and surfaces server errors', async () => {
    const user = userEvent.setup();
    loginMock.mockRejectedValueOnce(new Error('Invalid email or password'));
    render(<LoginPage />);
    await user.type(screen.getByLabelText('Email'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'wrong-password-99');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Invalid email or password')).toBeInTheDocument();
    expect(loginMock).toHaveBeenCalledWith(
      '/auth/login',
      expect.objectContaining({ body: expect.objectContaining({ email: 'a@b.co' }) }),
    );
  });

  it('offers workspace choice on MULTIPLE_ORGS', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../lib/api');
    loginMock.mockRejectedValueOnce(
      new ApiError(409, {
        message: 'ambiguous',
        code: 'MULTIPLE_ORGS',
        orgs: [{ slug: 'acme', name: 'Acme', status: 'active' }],
      }),
    );
    render(<LoginPage />);
    await user.type(screen.getByLabelText('Email'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-12');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    await waitFor(() => expect(loginMock).toHaveBeenCalledTimes(1));
  });
});
