import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type AuditEntry } from '../../lib/api';
import { Badge, Button, Card, EmptyState, Input, Skeleton } from '../../components/ui';

interface AuditResult {
  entries: AuditEntry[];
  nextCursor: string | null;
}

export function AuditPage(): React.JSX.Element {
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const log = useQuery({
    queryKey: ['audit-log', action, entityType, cursor],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '25' });
      if (action.trim()) params.set('action', action.trim());
      if (entityType.trim()) params.set('entityType', entityType.trim());
      if (cursor) params.set('cursor', cursor);
      return api<AuditResult>(`/audit-log?${params.toString()}`);
    },
  });

  function applyFilters(e: React.FormEvent): void {
    e.preventDefault();
    setCursor(undefined);
    void log.refetch();
  }

  return (
    <Card
      title="Audit log"
      description="Who changed what, with before/after values. Retained at least 12 months."
    >
      <form onSubmit={applyFilters} className="mb-4 flex flex-wrap items-end gap-2">
        <div>
          <label
            htmlFor="audit-action"
            className="mb-1 block text-xs font-medium text-text-secondary"
          >
            Action
          </label>
          <Input
            id="audit-action"
            placeholder="user.updated"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="w-48"
          />
        </div>
        <div>
          <label
            htmlFor="audit-entity"
            className="mb-1 block text-xs font-medium text-text-secondary"
          >
            Entity type
          </label>
          <Input
            id="audit-entity"
            placeholder="user"
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            className="w-40"
          />
        </div>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
      </form>

      {log.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : log.isError ? (
        <p role="alert" className="text-sm text-danger">
          Could not load the audit log.
        </p>
      ) : !log.data || log.data.entries.length === 0 ? (
        <EmptyState
          title="No audit entries"
          description="Matching entries will appear here as people use the workspace."
        />
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {log.data.entries.map((entry) => (
              <li key={entry.id} className="rounded-lg border border-border p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="info">{entry.action}</Badge>
                  <span className="text-text-secondary">
                    {entry.entityType}
                    {entry.entityId ? ` ${entry.entityId.slice(0, 8)}…` : ''}
                  </span>
                  <span className="ml-auto text-xs text-text-secondary">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1 text-xs text-text-secondary">
                  {entry.actorEmail ?? 'system'}
                  {entry.ipAddress ? ` · ${entry.ipAddress}` : ''}
                </p>
                {(entry.oldValues || entry.newValues) && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-accent">Before / after</summary>
                    <pre className="mt-1 overflow-x-auto rounded bg-surface-sunken p-2 font-mono text-xs">
                      {JSON.stringify({ before: entry.oldValues, after: entry.newValues }, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2">
            {cursor && (
              <Button variant="secondary" onClick={() => setCursor(undefined)}>
                Back to latest
              </Button>
            )}
            {log.data.nextCursor && (
              <Button variant="secondary" onClick={() => setCursor(log.data!.nextCursor!)}>
                Older entries
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
