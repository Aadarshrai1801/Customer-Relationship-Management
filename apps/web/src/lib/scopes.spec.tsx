import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { hasScope, type SessionUser } from './api';

function userWith(scopes: string[]): SessionUser {
  return {
    id: 'u1',
    email: 'u@test.com',
    name: 'U',
    status: 'active',
    role: {
      id: 'r1',
      key: 'rep',
      name: 'Rep',
      permissions: { version: 1, scopes, recordAccess: {}, fields: {} },
    },
  };
}

describe('hasScope', () => {
  it('grants exact scopes and the owner wildcard', () => {
    expect(hasScope(userWith(['users:read']), 'users:read')).toBe(true);
    expect(hasScope(userWith(['users:read']), 'users:manage')).toBe(false);
    expect(hasScope(userWith(['*']), 'audit:read')).toBe(true);
  });

  it('denies when there is no user', () => {
    expect(hasScope(null, 'users:read')).toBe(false);
  });

  it('renders scope-gated content accordingly', () => {
    const viewer = userWith([]);
    const admin = userWith(['*']);
    const { rerender } = render(<span>{hasScope(viewer, 'audit:read') ? 'shown' : 'hidden'}</span>);
    expect(screen.getByText('hidden')).toBeInTheDocument();
    rerender(<span>{hasScope(admin, 'audit:read') ? 'shown' : 'hidden'}</span>);
    expect(screen.getByText('shown')).toBeInTheDocument();
  });
});
