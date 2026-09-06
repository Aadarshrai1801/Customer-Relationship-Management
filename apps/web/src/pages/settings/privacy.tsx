import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, API_URL, type ExportSummary } from '../../lib/api';
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

const eraseSchema = z.object({
  password: z.string().optional(),
});

export function PrivacyPage(): React.JSX.Element {
  const { clear } = useAuth();
  const { notify } = useToast();
  const [eraseOpen, setEraseOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exports = useQuery({
    queryKey: ['exports'],
    queryFn: () => api<ExportSummary[]>('/privacy/exports'),
    refetchInterval: (query) => {
      const pending = query.state.data?.some(
        (e) => e.status === 'pending' || e.status === 'processing',
      );
      return pending ? 2000 : false;
    },
  });

  const eraseForm = useForm<{ password?: string }>({
    resolver: zodResolver(eraseSchema),
    defaultValues: {},
  });

  const requestMutation = useMutation({
    mutationFn: () => api<{ id: string; status: string }>('/privacy/export', { method: 'POST' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['exports'] });
      notify('success', 'Export requested — download appears here when ready');
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Request failed'),
  });

  const eraseMutation = useMutation({
    mutationFn: (values: { password?: string }) =>
      api('/privacy/erase', { method: 'POST', body: values }),
    onSuccess: () => {
      clear();
      window.location.assign('/login');
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Erasure failed'),
  });

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Export your data"
        description="A JSON package of your profile, sessions, invitations, and activity. Ready in minutes, downloadable for 7 days."
        actions={<Button onClick={() => requestMutation.mutate()}>Request export</Button>}
      >
        <FormError message={error} />
        {exports.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !exports.data || exports.data.length === 0 ? (
          <EmptyState
            title="No exports yet"
            description="Request one to receive a downloadable copy of your personal data."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {exports.data.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm"
              >
                <span className="flex items-center gap-2">
                  <Badge
                    tone={
                      item.status === 'ready'
                        ? 'success'
                        : item.status === 'failed' || item.status === 'expired'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {item.status}
                  </Badge>
                  <span className="text-xs text-text-secondary">
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </span>
                {item.status === 'ready' && (
                  <a
                    className="text-accent hover:underline"
                    href={`${API_URL}/v1/privacy/export/${item.id}/download`}
                  >
                    Download
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Erase your data"
        description="Permanently deletes your account, sessions, and personal data. The audit trail keeps one receipt row. This cannot be undone."
        actions={
          <Button variant="danger" onClick={() => setEraseOpen(true)}>
            Erase my data
          </Button>
        }
      >
        <p className="text-sm text-text-secondary">
          You cannot erase the last owner of a workspace — transfer ownership first.
        </p>
      </Card>

      <Modal
        open={eraseOpen}
        onOpenChange={setEraseOpen}
        title="Erase all of my data?"
        description="Type-free confirmation: enter your password if your account has one, then confirm."
      >
        <form
          onSubmit={eraseForm.handleSubmit((v) => {
            setError(null);
            eraseMutation.mutate(v);
          })}
          className="flex flex-col gap-4"
        >
          <Field
            label="Password (if your account has one)"
            htmlFor="erase-password"
            error={eraseForm.formState.errors.password?.message}
          >
            <Input
              id="erase-password"
              type="password"
              autoComplete="current-password"
              {...eraseForm.register('password')}
            />
          </Field>
          <FormError message={error} />
          <div>
            <Button type="submit" variant="danger" disabled={eraseMutation.isPending}>
              {eraseMutation.isPending ? 'Erasing…' : 'Erase everything'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
