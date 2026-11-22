import { useState } from 'react';
import { api } from '../api.ts';
import { useLive } from '../live.tsx';
import { agoIso, useNow } from '../ui.tsx';

type Filter = 'all' | 'unread' | 'high';

/** Notification center: read/unread state, priorities and full history. */
export function Notifications() {
  const { notifications, unread } = useLive();
  const now = useNow();
  const [filter, setFilter] = useState<Filter>('all');
  const list = notifications.filter((n) => (filter === 'unread' ? n.readAt === null : filter === 'high' ? n.priority === 'high' : true));
  return (
    <div className="page" data-page="notifications">
      <h2>Notifications</h2>
      <div className="row toolbar">
        {(['all', 'unread', 'high'] as const).map((f) => (
          <button key={f} className={filter === f ? 'tab on' : 'tab'} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'unread' ? `Unread (${unread})` : 'High priority'}
          </button>
        ))}
        <button className="ghost" disabled={unread === 0} onClick={() => void api.markRead({ all: true })}>
          Mark all read
        </button>
      </div>
      <ul className="notes big" data-notifications>
        {list.map((n) => (
          <li key={n.id} className={`prio-${n.priority} ${n.readAt ? 'read' : 'unread'}`} data-notification={n.id} data-read={n.readAt ? 'true' : 'false'}>
            <div>
              <strong>{n.title}</strong> <span className="pill prio">{n.priority}</span> <span className="muted">{agoIso(n.createdAt, now)}</span>
            </div>
            <div>{n.body}</div>
            <button className="ghost" onClick={() => void api.markRead({ ids: [n.id], read: n.readAt === null })}>
              {n.readAt ? 'Mark unread' : 'Mark read'}
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="muted">Nothing here.</li>}
      </ul>
    </div>
  );
}
