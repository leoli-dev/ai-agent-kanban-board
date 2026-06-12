import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppNotification } from '@akb/shared';
import { api } from '../lib/api';
import { useWsTopics } from '../lib/ws';

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<AppNotification[]>('/api/notifications'),
    // Notifications endpoint lands in P6; don't spam errors until then.
    retry: false,
  });

  useWsTopics(['global'], (msg) => {
    if (msg.type === 'notification.new') {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    }
  });

  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-md p-1.5 text-slate-300 hover:bg-slate-800"
        aria-label="Notifications"
      >
        🔔
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-30 max-h-96 w-80 overflow-auto rounded-lg border border-slate-700 bg-slate-900 shadow-xl">
          {notifications.length === 0 ? (
            <p className="p-4 text-sm text-slate-400">No notifications yet.</p>
          ) : (
            notifications.map((n) => (
              <button
                key={n.id}
                className={`block w-full border-b border-slate-800 px-4 py-3 text-left last:border-0 hover:bg-slate-800/50 ${
                  n.read ? 'opacity-60' : ''
                }`}
                onClick={async () => {
                  if (!n.read) {
                    await api.patch(`/api/notifications/${n.id}`, { read: true });
                    queryClient.invalidateQueries({ queryKey: ['notifications'] });
                  }
                }}
              >
                <p className="text-sm font-medium text-slate-100">{n.title}</p>
                <p className="mt-0.5 text-xs text-slate-400">{n.body}</p>
                <p className="mt-1 text-[10px] text-slate-500">
                  {new Date(n.createdAt).toLocaleString()}
                </p>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
