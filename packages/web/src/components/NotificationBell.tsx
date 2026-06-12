import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppNotification } from '@akb/shared';
import { api } from '../lib/api';
import { useWsTopics } from '../lib/ws';
import { useT } from '../lib/i18n';
import { IconBell } from './icons';

export function NotificationBell() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<AppNotification[]>('/api/notifications'),
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
        className="btn relative rounded-lg p-2 text-ink-300 hover:bg-ink-800"
        aria-label={t('notif.aria')}
      >
        <IconBell width={17} height={17} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-400 px-1 font-mono text-[10px] font-bold text-ink-950 tabular">
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-30 max-h-96 w-80 overflow-auto rounded-xl border border-ink-700 bg-ink-900 shadow-2xl shadow-black/40">
          {notifications.length === 0 ? (
            <p className="p-4 text-sm text-ink-400">{t('notif.empty')}</p>
          ) : (
            notifications.map((n) => (
              <button
                key={n.id}
                className={`block w-full border-b border-ink-800 px-4 py-3 text-left transition-colors last:border-0 hover:bg-ink-850 ${
                  n.read ? 'opacity-55' : ''
                }`}
                onClick={async () => {
                  if (!n.read) {
                    await api.patch(`/api/notifications/${n.id}`, { read: true });
                    queryClient.invalidateQueries({ queryKey: ['notifications'] });
                  }
                }}
              >
                <p className="text-sm font-medium text-ink-100">{n.title}</p>
                <p className="mt-0.5 text-xs text-ink-400">{n.body}</p>
                <p className="mt-1 font-mono text-[10px] text-ink-500">
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
