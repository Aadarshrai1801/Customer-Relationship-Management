import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, hasScope, type DirectoryUser, type RoleDetails } from '../../lib/api';
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

const inviteSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  roleKey: z.string().min(1, 'Choose a role'),
});

export function UsersPage(): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const directory = useQuery({
    queryKey: ['users'],
    queryFn: () => api<DirectoryUser[]>('/users'),
  });
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api<RoleDetails[]>('/roles'),
    enabled: hasScope(user, 'roles:read'),
  });

  const inviteForm = useForm<{ email: string; roleKey: string }>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: '', roleKey: 'rep' },
  });

  const inviteMutation = useMutation({
    mutationFn: (values: { email: string; roleKey: string }) =>
      api('/auth/invites', { method: 'POST', body: values }),
    onSuccess: () => {
      setInviteOpen(false);
      inviteForm.reset();
      notify('success', 'Invitation sent');
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Invite failed'),
  });

  async function setStatus(id: string, activate: boolean): Promise<void> {
    setError(null);
    try {
      await api(`/users/${id}/${activate ? 'activate' : 'suspend'}`, { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      notify('success', activate ? 'User activated' : 'User suspended');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  async function changeRole(id: string, roleKey: string): Promise<void> {
    setError(null);
    try {
      await api(`/users/${id}/role`, { method: 'PATCH', body: { roleKey } });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      notify('success', 'Role updated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Role change failed');
    }
  }

  const canManage = hasScope(user, 'users:manage');
  const canInvite = hasScope(user, 'users:invite');

  return (
    <Card
      title="Users"
      description="Everyone with access to this workspace."
      actions={
        canInvite ? <Button onClick={() => setInviteOpen(true)}>Invite user</Button> : undefined
      }
    >
      <FormError message={error} />
      {directory.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : !directory.data || directory.data.length === 0 ? (
        <EmptyState
          title="No users yet"
          description="Invite your team to get started."
          action={
            canInvite ? <Button onClick={() => setInviteOpen(true)}>Invite user</Button> : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-text-secondary">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Name
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Email
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Role
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Status
                </th>
                {canManage && (
                  <th scope="col" className="py-2 font-medium">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {directory.data.map((member) => (
                <tr key={member.id} className="border-b border-border last:border-0">
                  <td className="py-2 pr-4 font-medium">{member.name}</td>
                  <td className="py-2 pr-4">{member.email ?? '—'}</td>
                  <td className="py-2 pr-4">
                    {canManage ? (
                      <select
                        aria-label={`Role for ${member.name}`}
                        value={member.role.key}
                        onChange={(e) => void changeRole(member.id, e.target.value)}
                        className="h-8 rounded border border-border bg-surface px-2 text-sm"
                      >
                        {(roles.data ?? [{ key: member.role.key, name: member.role.name }]).map(
                          (role) => (
                            <option key={role.key} value={role.key}>
                              {role.name}
                            </option>
                          ),
                        )}
                      </select>
                    ) : (
                      member.role.name
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    <Badge tone={member.status === 'active' ? 'success' : 'warning'}>
                      {member.status}
                    </Badge>
                  </td>
                  {canManage && (
                    <td className="py-2">
                      {member.id !== user?.id &&
                        (member.status === 'active' ? (
                          <button
                            type="button"
                            onClick={() => void setStatus(member.id, false)}
                            className="text-sm text-danger hover:underline"
                          >
                            Suspend
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void setStatus(member.id, true)}
                            className="text-sm text-accent hover:underline"
                          >
                            Activate
                          </button>
                        ))}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        title="Invite a user"
        description="They will receive an email with a link valid for 7 days."
      >
        <form
          onSubmit={inviteForm.handleSubmit((v) => {
            setError(null);
            inviteMutation.mutate(v);
          })}
          className="flex flex-col gap-4"
        >
          <Field
            label="Email"
            htmlFor="invite-email"
            error={inviteForm.formState.errors.email?.message}
          >
            <Input id="invite-email" type="email" {...inviteForm.register('email')} />
          </Field>
          <Field label="Role" htmlFor="invite-role">
            <select
              id="invite-role"
              {...inviteForm.register('roleKey')}
              className="h-9 rounded border border-border bg-surface px-3 text-sm"
            >
              {(roles.data ?? []).map((role) => (
                <option key={role.key} value={role.key}>
                  {role.name}
                </option>
              ))}
            </select>
          </Field>
          <FormError message={error} />
          <div>
            <Button type="submit" disabled={inviteMutation.isPending}>
              {inviteMutation.isPending ? 'Sending…' : 'Send invitation'}
            </Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}
