import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope } from '../lib/api';
import { useAuth } from '../lib/providers';
import type { CommentEntityType, SerializedComment } from '../lib/crm-types';
import { Button, Card, Skeleton } from './ui';
import { useToast } from './toast';

interface CommentsResponse {
  comments: SerializedComment[];
  nextCursor: string | null;
}

export function CommentsThread({
  entityType,
  entityId,
}: {
  entityType: CommentEntityType;
  entityId: string;
}): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const canManage = hasScope(user, 'comments:manage');
  const queryKey = ['comments', entityType, entityId];

  const commentsQuery = useQuery({
    queryKey,
    queryFn: () => api<CommentsResponse>(`/comments?entityType=${entityType}&entityId=${entityId}`),
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey });
    // Contact comments feed the Activity Timeline tab on contact detail.
    if (entityType === 'contact') {
      void queryClient.invalidateQueries({ queryKey: ['contact-timeline', entityId] });
    }
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!draft.trim()) throw new Error('Write a comment first');
      return api('/comments', {
        method: 'POST',
        body: { entityType, entityId, body: draft.trim() },
      });
    },
    onSuccess: () => {
      setDraft('');
      refresh();
      notify('success', 'Comment posted');
    },
    onError: (err: Error) => notify('error', err.message || 'Failed to post comment'),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: string }) =>
      api(`/comments/${id}`, { method: 'PATCH', body: { body } }),
    onSuccess: () => {
      setEditingId(null);
      setEditDraft('');
      refresh();
      notify('success', 'Comment updated');
    },
    onError: (err: Error) => notify('error', err.message || 'Failed to update comment'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/comments/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      notify('success', 'Comment deleted');
    },
    onError: (err: Error) => notify('error', err.message || 'Failed to delete comment'),
  });

  const comments = commentsQuery.data?.comments ?? [];
  const canModerate = hasScope(user, 'users:manage');

  return (
    <Card title="Comments" description="Discuss with your team. Type @email to notify a teammate.">
      {commentsQuery.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : comments.length === 0 ? (
        <p className="text-xs italic text-text-secondary">No comments yet.</p>
      ) : (
        <ul className="flex flex-col gap-2 text-xs">
          {comments.map((comment) => {
            const mine = comment.authorId === user?.id;
            const editable = canManage && (mine || canModerate);
            return (
              <li
                key={comment.id}
                aria-label={`Comment by ${comment.author?.name ?? 'unknown'}`}
                className="flex flex-col gap-1 rounded border border-border px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {comment.author?.name ?? 'Unknown'}
                    <span className="ml-2 font-normal text-text-secondary">
                      {new Date(comment.createdAt).toLocaleString()}
                    </span>
                  </span>
                  {editable && (
                    <span className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(comment.id);
                          setEditDraft(comment.body);
                        }}
                        className="rounded px-1.5 py-0.5 text-accent hover:bg-surface-raised"
                        aria-label={`Edit comment by ${comment.author?.name ?? 'unknown'}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteMutation.mutate(comment.id)}
                        className="rounded px-1.5 py-0.5 text-danger hover:bg-danger-soft"
                        aria-label={`Delete comment by ${comment.author?.name ?? 'unknown'}`}
                      >
                        Delete
                      </button>
                    </span>
                  )}
                </div>
                {editingId === comment.id ? (
                  <form
                    className="flex flex-col gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (editDraft.trim())
                        updateMutation.mutate({ id: comment.id, body: editDraft.trim() });
                    }}
                  >
                    <textarea
                      aria-label="Edit comment"
                      rows={2}
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      className="w-full rounded border border-accent bg-surface p-2 text-xs focus:outline-none"
                    />
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </Button>
                      <Button type="submit" variant="primary" className="h-7 text-xs">
                        Save
                      </Button>
                    </div>
                  </form>
                ) : (
                  <p className="whitespace-pre-wrap">{comment.body}</p>
                )}
                {comment.mentionedUsers.length > 0 && (
                  <p className="text-text-secondary">
                    Notified: {comment.mentionedUsers.map((u) => u.email).join(', ')}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canManage && (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            createMutation.mutate();
          }}
        >
          <textarea
            aria-label="Write a comment"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write a comment… mention teammates with @email"
            className="w-full rounded border border-border bg-surface p-2.5 text-xs focus:border-accent focus:outline-none"
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              disabled={createMutation.isPending || !draft.trim()}
              className="h-8 text-xs"
            >
              {createMutation.isPending ? 'Posting…' : 'Post comment'}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
