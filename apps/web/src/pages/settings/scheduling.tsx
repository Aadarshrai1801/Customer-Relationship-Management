import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
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

interface BookingLink {
  id: string;
  owner: { id: string; name: string } | null;
  name: string;
  slug: string;
  durationMinutes: number;
  description: string | null;
  isActive: boolean;
  publicUrlPath: string;
  createdAt: string;
  updatedAt: string;
}

export function SchedulingPage(): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const canManage = hasScope(user, 'activities:manage');

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [duration, setDuration] = useState('30');
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const linksQuery = useQuery({
    queryKey: ['booking-links'],
    queryFn: () => api<BookingLink[]>('/booking-links'),
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ['booking-links'] });
  }

  const createMutation = useMutation({
    mutationFn: () =>
      api<{ link: BookingLink }>('/booking-links', {
        method: 'POST',
        body: {
          name: name.trim(),
          durationMinutes: Number(duration),
          description: description.trim() || undefined,
        },
      }),
    onSuccess: () => {
      setCreateOpen(false);
      setName('');
      setDuration('30');
      setDescription('');
      setFormError(null);
      refresh();
      notify('success', 'Booking link created');
    },
    onError: (err: Error) => setFormError(err.message || 'Creation failed'),
  });

  const toggleMutation = useMutation({
    mutationFn: (link: BookingLink) =>
      api(`/booking-links/${link.id}`, {
        method: 'PATCH',
        body: { isActive: !link.isActive },
      }),
    onSuccess: () => {
      refresh();
      notify('success', 'Booking link updated');
    },
    onError: (err: Error) => notify('error', err.message || 'Update failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/booking-links/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      notify('success', 'Booking link deleted');
    },
    onError: (err: Error) => notify('error', err.message || 'Delete failed'),
  });

  const links = linksQuery.data ?? [];

  function copyPublicUrl(link: BookingLink): void {
    const url = `${window.location.origin}${link.publicUrlPath}`;
    void navigator.clipboard
      ?.writeText(url)
      .then(() => notify('success', 'Public booking URL copied'))
      .catch(() => notify('error', 'Copy failed'));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Scheduling</h1>
          <p className="mt-1 text-xs text-text-secondary">
            Share a public link; bookers pick a weekday slot and land in your pipeline as a contact
            plus a meeting activity.
          </p>
        </div>
        {canManage && (
          <Button variant="primary" onClick={() => setCreateOpen(true)} className="h-9 text-xs">
            + New Link
          </Button>
        )}
      </div>

      <Card title="Booking links" description="Weekdays 9:00–17:00 UTC, next 14 days.">
        {linksQuery.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : linksQuery.isError ? (
          <div className="rounded bg-danger-soft p-4 text-sm text-danger">
            Could not load links: {linksQuery.error?.message}
          </div>
        ) : links.length === 0 ? (
          <EmptyState
            title="No booking links"
            description="Create a link to start accepting public bookings."
          />
        ) : (
          <ul className="flex flex-col gap-2 text-xs">
            {links.map((link) => (
              <li
                key={link.id}
                className="flex flex-col gap-2 rounded-lg border border-border px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">{link.name}</span>
                  <Badge tone={link.isActive ? 'success' : 'neutral'}>
                    {link.isActive ? 'active' : 'off'}
                  </Badge>
                  <span className="text-text-secondary">
                    {link.durationMinutes} min
                    {link.owner ? ` · ${link.owner.name}` : ''}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-surface-raised px-2 py-1 text-text-secondary">
                    {link.publicUrlPath}
                  </code>
                  <Button
                    variant="ghost"
                    onClick={() => copyPublicUrl(link)}
                    className="h-7 text-xs"
                  >
                    Copy URL
                  </Button>
                  {canManage && (
                    <>
                      <Button
                        variant="ghost"
                        onClick={() => toggleMutation.mutate(link)}
                        className="h-7 text-xs"
                      >
                        {link.isActive ? 'Deactivate' : 'Activate'}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (window.confirm(`Delete "${link.name}"?`)) {
                            deleteMutation.mutate(link.id);
                          }
                        }}
                        className="h-7 text-xs text-danger"
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New booking link">
        <div className="flex flex-col gap-3">
          <Field label="Name" htmlFor="booking-link-name">
            <Input
              id="booking-link-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Intro Call"
            />
          </Field>
          <Field label="Duration (minutes)" htmlFor="booking-link-duration">
            <select
              id="booking-link-duration"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className="h-9 rounded border border-border bg-surface px-2 text-xs"
            >
              {['15', '30', '45', '60'].map((d) => (
                <option key={d} value={d}>
                  {d} minutes
                </option>
              ))}
            </select>
          </Field>
          <Field label="Description (optional)" htmlFor="booking-link-description">
            <Input
              id="booking-link-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this meeting covers"
            />
          </Field>
          <FormError message={formError} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)} className="h-9 text-xs">
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!name.trim()) {
                  setFormError('Name is required');
                  return;
                }
                createMutation.mutate();
              }}
              className="h-9 text-xs"
            >
              Create Link
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
