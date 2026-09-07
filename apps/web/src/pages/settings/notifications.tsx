import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Badge, Card, Skeleton } from '../../components/ui';
import { useToast } from '../../components/toast';

const KNOWN_TYPES = [
  { type: 'mention', label: 'Mentions', hint: '@mentions in comments' },
  { type: 'task_digest', label: 'Task digests', hint: 'Daily overdue/reminder batch' },
  { type: 'lead_assigned', label: 'Lead assignments', hint: 'Routing notifications' },
] as const;

const CHANNELS = [
  { key: 'inapp', label: 'In-app' },
  { key: 'email', label: 'Email' },
] as const;

export function NotificationPreferencesPage(): React.JSX.Element {
  const { notify } = useToast();
  const queryClient = useQueryClient();
  // Optimistic overlay so toggles flip instantly under latency.
  const [optimistic, setOptimistic] = useState<Record<string, string[]>>({});

  const prefsQuery = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => api<Record<string, string[]>>('/notifications/preferences'),
  });

  const saveMutation = useMutation({
    mutationFn: async ({ type, channels }: { type: string; channels: string[] }) =>
      api('/notifications/preferences', { method: 'POST', body: { type, channels } }),
    onSuccess: (_data, variables) => {
      setOptimistic((prev) => {
        const next = { ...prev };
        delete next[variables.type];
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ['notification-preferences'] });
      notify('success', 'Preferences saved');
    },
    onError: (err: Error, variables) => {
      setOptimistic((prev) => {
        const next = { ...prev };
        delete next[variables.type];
        return next;
      });
      notify('error', err.message || 'Save failed');
    },
  });

  const prefs = { ...(prefsQuery.data ?? {}), ...optimistic };

  function toggle(type: string, channel: string, on: boolean): void {
    const current = new Set(prefs[type] ?? ['inapp', 'email']);
    if (on) current.add(channel);
    else current.delete(channel);
    if (current.size === 0) {
      notify('error', 'Keep at least one channel on');
      return;
    }
    const channels = [...current];
    setOptimistic((prev) => ({ ...prev, [type]: channels }));
    saveMutation.mutate({ type, channels });
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight text-text-primary">Notifications</h1>
      <Card
        title="Channel preferences"
        description="Per-type routing. Digest emails only go out for days with actual activity."
      >
        {prefsQuery.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <ul className="flex flex-col gap-3">
            {KNOWN_TYPES.map((row) => {
              const active = new Set(prefs[row.type] ?? ['inapp', 'email']);
              return (
                <li
                  key={row.type}
                  className="flex flex-col gap-1 rounded border border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-sm font-medium text-text-primary">
                      {row.label} <Badge tone="neutral">{row.type}</Badge>
                    </p>
                    <p className="text-xs text-text-secondary">{row.hint}</p>
                  </div>
                  <div className="flex gap-4">
                    {CHANNELS.map((channel) => {
                      return (
                        <label key={channel.key} className="flex items-center gap-1.5 text-xs">
                          <input
                            type="checkbox"
                            aria-label={`${row.label} ${channel.label}`}
                            checked={active.has(channel.key)}
                            onChange={(e) => toggle(row.type, channel.key, e.target.checked)}
                          />
                          {channel.label}
                        </label>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
