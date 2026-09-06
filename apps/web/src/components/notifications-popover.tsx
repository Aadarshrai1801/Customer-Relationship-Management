import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope } from '../lib/api';
import { useAuth } from '../lib/providers';
import type { AppNotification } from '../lib/crm-types';
import { useToast } from './toast';

interface NotificationsResponse {
  items: AppNotification[];
  unreadCount: number;
}

export function NotificationsPopover(): React.JSX.Element | null {
  const { user } = useAuth();
  const { notify } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const canRead = hasScope(user, 'notifications:read');

  // Query notifications with periodic polling
  const { data, isLoading } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<NotificationsResponse>('/notifications?limit=20'),
    enabled: !!user && canRead,
    refetchInterval: 15000,
  });

  // Mark single notification as read
  const markReadMutation = useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'PATCH' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  // Mark all as read
  const markAllReadMutation = useMutation({
    mutationFn: () => api('/notifications/read-all', { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      notify('success', 'All notifications marked as read');
    },
  });

  // Close when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  if (!canRead) return null;

  const notifications = data?.items ?? [];
  const unreadCount = data?.unreadCount ?? 0;

  const handleNotificationClick = async (notif: AppNotification) => {
    if (!notif.readAt) {
      await markReadMutation.mutateAsync(notif.id);
    }
    setOpen(false);
    if (notif.link) {
      void navigate({ to: notif.link });
    }
  };

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={`Notifications (${unreadCount} unread)`}
        title="Notifications"
        className="relative inline-flex h-8 w-8 items-center justify-center rounded text-text-secondary hover:bg-surface-raised hover:text-text-primary transition-colors focus-visible:outline-none"
      >
        <svg
          className="h-4.5 w-4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
          />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white shadow-sm">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications popover"
          className="absolute right-0 top-full mt-2 w-80 sm:w-96 rounded-lg border border-border bg-surface shadow-medium z-50 overflow-hidden"
        >
          <div className="flex items-center justify-between border-b border-border bg-surface-raised/50 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-text-primary">Notifications</span>
              {unreadCount > 0 && (
                <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
                  {unreadCount} new
                </span>
              )}
            </div>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => markAllReadMutation.mutate()}
                disabled={markAllReadMutation.isPending}
                className="text-xs text-accent hover:text-accent-hover font-medium transition-colors disabled:opacity-50"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-[380px] overflow-y-auto divide-y divide-border/60">
            {isLoading ? (
              <div className="p-4 text-center text-xs text-text-secondary">Loading notifications...</div>
            ) : notifications.length === 0 ? (
              <div className="p-6 text-center text-xs text-text-secondary">
                No notifications right now.
              </div>
            ) : (
              notifications.map((notif) => {
                const isUnread = !notif.readAt;
                return (
                  <button
                    key={notif.id}
                    type="button"
                    onClick={() => void handleNotificationClick(notif)}
                    className={`w-full text-left p-3.5 hover:bg-surface-raised transition-colors flex items-start gap-3 ${
                      isUnread ? 'bg-accent-soft/20' : 'bg-surface'
                    }`}
                  >
                    <span
                      className={`mt-1 h-2 w-2 rounded-full shrink-0 ${
                        isUnread ? 'bg-accent' : 'bg-transparent'
                      }`}
                      aria-hidden="true"
                    />
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs ${isUnread ? 'font-semibold text-text-primary' : 'font-medium text-text-secondary'}`}>
                        {notif.title}
                      </p>
                      <p className="mt-0.5 text-xs text-text-secondary line-clamp-2">
                        {notif.body}
                      </p>
                      <p className="mt-1 text-[10px] text-text-secondary/70">
                        {new Date(notif.createdAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
