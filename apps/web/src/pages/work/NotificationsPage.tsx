import { Card, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States';
import { useMarkAllRead, useNotifications } from '../../hooks/useApi';
import { relativeDay } from '../../lib/format';
import { cn } from '../../lib/cn';

export function NotificationsPage() {
  const { data, isPending, error, refetch } = useNotifications();
  const markAll = useMarkAllRead();

  if (isPending) return <Card><Skeleton rows={6} /></Card>;
  if (error || !data) return <Card><ErrorState error={error} onRetry={() => void refetch()} /></Card>;

  return (
    <div className="space-y-5">
      <h1 className="font-display text-[27px] font-semibold leading-tight text-ink">Notifications</h1>

      {data.digestHeadline ? (
        <div className="rounded-card border border-line bg-brand-tint px-5 py-3.5 text-[14px] text-brand-deep">
          {data.digestHeadline}
        </div>
      ) : null}

      <Card>
        <CardHeader
          title="Inbox"
          hint={data.unreadCount === 0 ? 'All caught up' : `${data.unreadCount} unread`}
          action={
            data.unreadCount > 0 ? (
              <Button
                size="sm"
                variant="secondary"
                loading={markAll.isPending}
                onClick={() => markAll.mutate()}
              >
                Mark all read
              </Button>
            ) : undefined
          }
        />

        {data.notifications.length === 0 ? (
          <EmptyState
            title="Nothing here"
            body="Reminders about classes, homework, results and fees will show up here."
          />
        ) : (
          <ul className="divide-y divide-line">
            {data.notifications.map((item) => (
              <li
                key={item.id}
                className={cn('px-5 py-3.5', item.readAt === null && 'bg-brand-tint/40')}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[14px] font-semibold text-ink">{item.title}</p>
                      <Badge>{item.category.toLowerCase().replace(/_/g, ' ')}</Badge>
                    </div>
                    <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">{item.body}</p>
                  </div>
                  <span className="shrink-0 text-[12px] text-ink-muted">
                    {relativeDay(item.createdAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
