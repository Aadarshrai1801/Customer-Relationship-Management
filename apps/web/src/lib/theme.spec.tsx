import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme } from '../lib/theme';

function ThemeProbe(): React.JSX.Element {
  const { theme, toggle } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button type="button" onClick={toggle}>
        toggle
      </button>
    </div>
  );
}

describe('theme', () => {
  it('toggles dark mode, persists it, and reflects it on <html>', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('nexus-theme')).toBe('dark');

    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
