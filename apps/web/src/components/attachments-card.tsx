import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, api, hasScope } from '../lib/api';
import { useAuth } from '../lib/providers';
import type { CommentEntityType, SerializedAttachment } from '../lib/crm-types';
import { Button, Card, Skeleton } from './ui';
import { useToast } from './toast';

interface AttachmentsResponse {
  attachments: SerializedAttachment[];
  nextCursor: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function uploadFiles(
  entityType: CommentEntityType,
  entityId: string,
  files: File[],
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const file of files) {
    const form = new FormData();
    form.append('entityType', entityType);
    form.append('entityId', entityId);
    form.append('file', file, file.name);
    const res = await fetch(`${API_URL}/v1/attachments/upload`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    const data = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const message =
        (data as { message?: string } | null)?.message ?? `Upload failed (${res.status})`;
      throw new Error(message);
    }
    results.push(data);
  }
  return results;
}

export function AttachmentsCard({
  entityType,
  entityId,
}: {
  entityType: CommentEntityType;
  entityId: string;
}): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canManage = hasScope(user, 'attachments:manage');
  const queryKey = ['attachments', entityType, entityId];

  const attachmentsQuery = useQuery({
    queryKey,
    queryFn: () =>
      api<AttachmentsResponse>(`/attachments?entityType=${entityType}&entityId=${entityId}`),
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey });
  }

  const uploadMutation = useMutation({
    mutationFn: (files: File[]) => uploadFiles(entityType, entityId, files),
    onSuccess: (results) => {
      setError(null);
      refresh();
      notify('success', `${results.length} file${results.length === 1 ? '' : 's'} uploaded`);
    },
    onError: (err: Error) => {
      setError(err.message || 'Upload failed');
      notify('error', err.message || 'Upload failed');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/attachments/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      notify('success', 'Attachment deleted');
    },
    onError: (err: Error) => notify('error', err.message || 'Failed to delete attachment'),
  });

  const files = attachmentsQuery.data?.attachments ?? [];

  return (
    <Card title="Attachments" description="Drag and drop files here, or browse to attach.">
      {attachmentsQuery.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : files.length === 0 ? (
        <p className="text-xs italic text-text-secondary">No files attached.</p>
      ) : (
        <ul className="flex flex-col gap-2 text-xs">
          {files.map((file) => (
            <li
              key={file.id}
              aria-label={`Attachment ${file.filename}`}
              className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2"
            >
              <span className="min-w-0">
                <a
                  href={`${API_URL}/v1/attachments/${file.id}/download`}
                  className="truncate font-medium text-accent hover:underline"
                >
                  {file.filename}
                </a>{' '}
                <span className="text-text-secondary">
                  {formatBytes(file.sizeBytes)} · {file.owner?.name ?? 'Unknown'}
                </span>
              </span>
              {canManage && (
                <button
                  type="button"
                  onClick={() => deleteMutation.mutate(file.id)}
                  className="shrink-0 rounded px-1.5 py-0.5 text-danger hover:bg-danger-soft"
                  aria-label={`Delete attachment ${file.filename}`}
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="mt-3">
          <div
            role="button"
            tabIndex={0}
            aria-label="Drop files to upload"
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') inputRef.current?.click();
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const dropped = [...(e.dataTransfer?.files ?? [])];
              if (dropped.length > 0) uploadMutation.mutate(dropped);
            }}
            className={`flex cursor-pointer flex-col items-center gap-1 rounded border border-dashed p-4 text-xs transition-colors ${
              dragging ? 'border-accent bg-accent-soft' : 'border-border text-text-secondary'
            }`}
          >
            <span>
              {uploadMutation.isPending ? 'Uploading…' : 'Drop files here or click to browse'}
            </span>
            <span>PDF, images, docs, zips · default 25MB per file</span>
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            aria-label="Choose files to upload"
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])];
              e.target.value = '';
              if (picked.length > 0) uploadMutation.mutate(picked);
            }}
          />
          {error && (
            <div role="alert" className="mt-2 rounded bg-danger-soft p-2 text-xs text-danger">
              {error}
            </div>
          )}
          <div className="mt-2 flex justify-end">
            <Button
              type="button"
              variant="secondary"
              className="h-8 text-xs"
              onClick={() => inputRef.current?.click()}
            >
              Browse files
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
