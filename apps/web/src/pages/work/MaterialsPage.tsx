import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader } from '../../components/ui/Card';
import { Badge, toneForStatus } from '../../components/ui/Badge';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States';
import { apiGet } from '../../lib/api-client';
import { keys } from '../../hooks/useApi';
import { relativeDay, subjectColor } from '../../lib/format';

interface Material {
  id: string;
  title: string;
  description: string | null;
  type: string;
  ingestStatus: string;
  chunkCount: number;
  createdAt: string;
  subject: { name: string; colorHex: string | null };
  files: { id: string; originalName: string; sizeBytes: number }[];
}

export function MaterialsPage() {
  const { data, isPending, error, refetch } = useQuery({
    queryKey: keys.materials,
    queryFn: () => apiGet<{ items: Material[] }>('/materials?pageSize=50'),
  });

  if (isPending) return <Card><Skeleton rows={5} /></Card>;
  if (error || !data) return <Card><ErrorState error={error} onRetry={() => void refetch()} /></Card>;

  return (
    <div className="space-y-5">
      <h1 className="font-display text-[27px] font-semibold leading-tight text-ink">Study material</h1>

      <Card>
        <CardHeader title="Available to you" hint="Uploaded by your teachers" />

        {data.items.length === 0 ? (
          <EmptyState
            title="Nothing uploaded yet"
            body="Once your teacher uploads notes for your batch, they appear here and become the source the AI questions are drawn from."
          />
        ) : (
          <ul className="divide-y divide-line">
            {data.items.map((item) => (
              <li key={item.id} className="flex items-start gap-3 px-5 py-3.5">
                <span
                  className="mt-1 h-8 w-1 shrink-0 rounded-full"
                  style={{ backgroundColor: subjectColor(item.subject.colorHex) }}
                />

                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14.5px] font-medium text-ink">{item.title}</p>
                  {item.description ? (
                    <p className="mt-0.5 line-clamp-2 text-[13px] leading-relaxed text-ink-muted">
                      {item.description}
                    </p>
                  ) : null}
                  <p className="mt-1 text-[12px] text-ink-muted">
                    {item.subject.name} · {item.type.toLowerCase()} ·{' '}
                    {item.files.length} file{item.files.length === 1 ? '' : 's'} ·{' '}
                    {relativeDay(item.createdAt)}
                  </p>
                </div>

                <div className="shrink-0 text-right">
                  <Badge tone={toneForStatus(item.ingestStatus === 'INDEXED' ? 'COMPLETED' : item.ingestStatus)}>
                    {item.ingestStatus.toLowerCase()}
                  </Badge>
                  {item.chunkCount > 0 ? (
                    <p className="mt-1 font-mono text-[11px] tabular-nums text-ink-muted">
                      {item.chunkCount} chunks
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-[12.5px] leading-relaxed text-ink-muted">
        Material marked <strong>indexed</strong> has been split and embedded, so AI-generated
        questions can be grounded in it and cite the exact passage they came from.
      </p>
    </div>
  );
}
