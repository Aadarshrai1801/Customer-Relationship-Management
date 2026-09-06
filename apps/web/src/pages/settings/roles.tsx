import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, hasScope, type RoleDetails, type RolePermissions } from '../../lib/api';
import { queryClient, useAuth } from '../../lib/providers';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  FormError,
  Input,
  Skeleton,
} from '../../components/ui';
import { Modal } from '../../components/modal';
import { useToast } from '../../components/toast';

const roleSchema = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/, 'Lowercase letters, numbers, dashes'),
  name: z.string().trim().min(1, 'Name is required').max(100),
  scopes: z.string().trim(),
});

const KNOWN_SCOPES = [
  'users:read',
  'users:invite',
  'users:manage',
  'roles:read',
  'roles:manage',
  'org:read',
  'org:manage',
  'audit:read',
];

export function RolesPage(): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<RoleDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api<RoleDetails[]>('/roles'),
  });

  const form = useForm<{ key: string; name: string; scopes: string }>({
    resolver: zodResolver(roleSchema),
    defaultValues: { key: '', name: '', scopes: 'users:read' },
  });

  const canManage = hasScope(user, 'roles:manage');

  const createMutation = useMutation({
    mutationFn: (values: { key: string; name: string; scopes: string }) =>
      api('/roles', {
        method: 'POST',
        body: {
          key: values.key,
          name: values.name,
          permissions: {
            version: 1,
            scopes: splitScopes(values.scopes),
            recordAccess: {},
            fields: {},
          } satisfies RolePermissions,
        },
      }),
    onSuccess: async () => {
      setCreateOpen(false);
      form.reset();
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
      notify('success', 'Role created');
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Create failed'),
  });

  async function remove(id: string): Promise<void> {
    setError(null);
    try {
      await api(`/roles/${id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
      notify('success', 'Role deleted');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function rename(role: RoleDetails, name: string): Promise<void> {
    setError(null);
    try {
      await api(`/roles/${role.id}`, { method: 'PATCH', body: { name } });
      setEditing(null);
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
      notify('success', 'Role renamed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
    }
  }

  return (
    <Card
      title="Roles"
      description="System roles are fixed; custom roles tailor access for the rest of the team."
      actions={
        canManage ? <Button onClick={() => setCreateOpen(true)}>New role</Button> : undefined
      }
    >
      <FormError message={error} />
      {roles.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : !roles.data || roles.data.length === 0 ? (
        <EmptyState title="No roles" description="Roles appear here once configured." />
      ) : (
        <ul className="flex flex-col gap-3">
          {roles.data.map((role) => (
            <li
              key={role.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"
            >
              <div>
                <p className="font-medium">
                  {role.name} {role.isSystem && <Badge tone="neutral">system</Badge>}
                </p>
                <p className="mt-1 text-xs text-text-secondary">
                  {role.permissions.scopes.length === 0
                    ? 'No scopes'
                    : role.permissions.scopes.join(', ')}
                </p>
              </div>
              {canManage && !role.isSystem && (
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => setEditing(role)}>
                    Rename
                  </Button>
                  <Button variant="danger" onClick={() => void remove(role.id)}>
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New custom role"
        description="Scopes grant API capabilities. Start narrow — you can broaden later."
      >
        <form
          onSubmit={form.handleSubmit((v) => {
            setError(null);
            createMutation.mutate(v);
          })}
          className="flex flex-col gap-4"
        >
          <Field
            label="Key"
            htmlFor="role-key"
            error={form.formState.errors.key?.message}
            hint="Unique, e.g. support-lead."
          >
            <Input id="role-key" {...form.register('key')} />
          </Field>
          <Field label="Name" htmlFor="role-name" error={form.formState.errors.name?.message}>
            <Input id="role-name" {...form.register('name')} />
          </Field>
          <Field
            label="Scopes"
            htmlFor="role-scopes"
            hint={`Comma-separated. Known scopes: ${KNOWN_SCOPES.join(', ')}`}
          >
            <Input id="role-scopes" {...form.register('scopes')} />
          </Field>
          <FormError message={error} />
          <div>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating…' : 'Create role'}
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title="Rename role"
      >
        {editing && (
          <RenameForm
            key={editing.id}
            initial={editing.name}
            onSubmit={(name) => void rename(editing, name)}
          />
        )}
      </Modal>
    </Card>
  );
}

function splitScopes(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function RenameForm({
  initial,
  onSubmit,
}: {
  initial: string;
  onSubmit: (name: string) => void;
}): React.JSX.Element {
  const [name, setName] = useState(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(name.trim());
      }}
      className="flex flex-col gap-4"
    >
      <Field label="Name" htmlFor="rename-name">
        <Input id="rename-name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div>
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}
