import { describe, expect, it } from 'vitest';
import {
  assertEditableFields,
  checkRecordAccess,
  fieldRule,
  filterReadableFields,
  hasScope,
  parsePermissions,
} from '../src/rbac/permissions';
import { SYSTEM_ROLE_SEEDS } from '../src/rbac/seeds';
import type { RolePermissions } from '@nexus/db';

function perms(partial: Partial<RolePermissions>): RolePermissions {
  return { version: 1, scopes: [], recordAccess: {}, fields: {}, ...partial };
}

describe('hasScope', () => {
  it('grants exact scope matches', () => {
    expect(hasScope(perms({ scopes: ['users:read'] }), 'users:read')).toBe(true);
  });

  it('denies scopes that are not granted', () => {
    expect(hasScope(perms({ scopes: ['users:read'] }), 'users:manage')).toBe(false);
  });

  it("grants everything with the '*' wildcard", () => {
    expect(hasScope(perms({ scopes: ['*'] }), 'anything:at-all')).toBe(true);
  });

  it('denies when permissions are missing or empty', () => {
    expect(hasScope(perms({}), 'users:read')).toBe(false);
    expect(hasScope(null, 'users:read')).toBe(false);
    expect(hasScope(undefined, 'users:read')).toBe(false);
  });
});

describe('checkRecordAccess', () => {
  it("allows other records with 'all' scope", () => {
    expect(() =>
      checkRecordAccess(perms({ recordAccess: { user: 'all' } }), 'user', 'other', 'actor'),
    ).not.toThrow();
  });

  it("allows own record with 'own' scope", () => {
    expect(() =>
      checkRecordAccess(perms({ recordAccess: { user: 'own' } }), 'user', 'actor', 'actor'),
    ).not.toThrow();
  });

  it("denies other records with 'own' scope", () => {
    try {
      checkRecordAccess(perms({ recordAccess: { user: 'own' } }), 'user', 'other', 'actor');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('RECORD_FORBIDDEN');
    }
  });

  it('defaults unknown entities to own (fail-closed)', () => {
    expect(() => checkRecordAccess(perms({}), 'deal', 'actor', 'actor')).not.toThrow();
    try {
      checkRecordAccess(perms({}), 'deal', 'other', 'actor');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('RECORD_FORBIDDEN');
    }
  });
});

describe('field rules', () => {
  it('defaults to edit when no rule is configured', () => {
    expect(fieldRule(perms({}), 'user', 'email')).toBe('edit');
  });

  it('strips none fields on read but keeps read/edit fields', () => {
    const record = { id: '1', email: 'a@b.c', name: 'A' };
    const out = filterReadableFields(
      perms({ fields: { 'user.email': 'none', 'user.name': 'read' } }),
      'user',
      record,
    );
    expect(out).toEqual({ id: '1', name: 'A' });
    expect(record).toEqual({ id: '1', email: 'a@b.c', name: 'A' });
  });

  it('rejects non-editable fields explicitly on write', () => {
    const p = perms({ fields: { 'user.name': 'read', 'user.email': 'none' } });
    expect(() => assertEditableFields(p, 'user', ['timezone'])).not.toThrow();
    try {
      assertEditableFields(p, 'user', ['name', 'timezone']);
      expect.unreachable('should have thrown');
    } catch (err) {
      const coded = err as { code?: string; fields?: string[] };
      expect(coded.code).toBe('FIELD_NOT_EDITABLE');
      expect(coded.fields).toEqual(['name']);
    }
  });
});

describe('parsePermissions', () => {
  it('accepts a valid permission set and applies defaults', () => {
    const parsed = parsePermissions({ version: 1, scopes: ['users:read'] });
    expect(parsed).toEqual({ version: 1, scopes: ['users:read'], recordAccess: {}, fields: {} });
  });

  it('rejects malformed scopes, field keys, and versions', () => {
    expect(() => parsePermissions({ version: 1, scopes: ['bogus scope'] })).toThrow();
    expect(() => parsePermissions({ version: 1, scopes: [], fields: { nope: 'none' } })).toThrow();
    expect(() =>
      parsePermissions({ version: 1, scopes: ['custom_fields:read', 'custom_fields:manage'] }),
    ).not.toThrow();
    expect(() => parsePermissions({ version: 2, scopes: [] })).toThrow();
    expect(() =>
      parsePermissions({ version: 1, scopes: [], recordAccess: { user: 'everyone' } }),
    ).toThrow();
  });
});

describe('system role seeds', () => {
  it('are all valid permission sets with unique keys', () => {
    const keys = SYSTEM_ROLE_SEEDS.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const seed of SYSTEM_ROLE_SEEDS) {
      expect(() => parsePermissions(seed.permissions)).not.toThrow();
    }
  });

  it('grants owners everything, viewers read-only schema, reps own records', () => {
    const owner = SYSTEM_ROLE_SEEDS.find((r) => r.key === 'owner')!;
    const admin = SYSTEM_ROLE_SEEDS.find((r) => r.key === 'admin')!;
    const manager = SYSTEM_ROLE_SEEDS.find((r) => r.key === 'manager')!;
    const viewer = SYSTEM_ROLE_SEEDS.find((r) => r.key === 'viewer')!;
    const rep = SYSTEM_ROLE_SEEDS.find((r) => r.key === 'rep')!;
    expect(hasScope(owner.permissions, 'users:manage')).toBe(true);
    expect(hasScope(viewer.permissions, 'users:read')).toBe(false);
    expect(hasScope(viewer.permissions, 'custom_fields:read')).toBe(true);
    expect(hasScope(rep.permissions, 'custom_fields:read')).toBe(true);
    expect(rep.permissions.recordAccess['user']).toBe('own');
    expect(hasScope(admin.permissions, 'deals:read')).toBe(true);
    expect(hasScope(admin.permissions, 'deals:manage')).toBe(true);
    expect(hasScope(admin.permissions, 'pipelines:manage')).toBe(true);
    expect(hasScope(manager.permissions, 'deals:read')).toBe(true);
    expect(hasScope(manager.permissions, 'deals:manage')).toBe(false);
    expect(hasScope(manager.permissions, 'pipelines:manage')).toBe(false);
    expect(hasScope(rep.permissions, 'deals:read')).toBe(true);
    expect(hasScope(rep.permissions, 'deals:manage')).toBe(true);
    expect(hasScope(viewer.permissions, 'deals:read')).toBe(true);
    expect(hasScope(viewer.permissions, 'deals:manage')).toBe(false);
    expect(hasScope(admin.permissions, 'tasks:manage')).toBe(true);
    expect(hasScope(admin.permissions, 'activities:manage')).toBe(true);
    expect(hasScope(manager.permissions, 'tasks:read')).toBe(true);
    expect(hasScope(manager.permissions, 'tasks:manage')).toBe(false);
    expect(hasScope(rep.permissions, 'tasks:manage')).toBe(true);
    expect(hasScope(viewer.permissions, 'tasks:manage')).toBe(false);
    expect(admin.permissions.recordAccess['deal']).toBe('all');
    expect(manager.permissions.recordAccess['deal']).toBe('all');
    expect(rep.permissions.recordAccess['deal']).toBe('own');
    expect(viewer.permissions.recordAccess['deal']).toBe('own');
    expect(admin.permissions.recordAccess['task']).toBe('all');
    expect(manager.permissions.recordAccess['task']).toBe('all');
    expect(rep.permissions.recordAccess['task']).toBe('own');
    expect(viewer.permissions.recordAccess['task']).toBe('own');
    expect(admin.permissions.recordAccess['activity']).toBe('all');
    expect(rep.permissions.recordAccess['activity']).toBe('own');
  });
});
