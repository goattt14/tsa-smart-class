import { useQuery } from '@tanstack/react-query';
import { Activity, Check, Database, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { defaultBranding } from '@/config/branding';
import { env } from '@/config/env';
import { apiGet, onColdStart } from '@/lib/api-client';
import { cn } from '@/lib/cn';

interface HealthPayload {
  status: string;
  service: string;
  environment: string;
  uptimeSec: number;
  timestamp: string;
}

interface DbHealthPayload {
  database: string;
  latencyMs: number;
  aiProvider: string;
  storageDriver: string;
}

function StatusRow({
  label,
  value,
  state,
}: {
  label: string;
  value: string;
  state: 'ok' | 'fail' | 'pending';
}) {
  return (
    <div className="flex items-center justify-between border-b border-line py-3 last:border-b-0">
      <span className="text-sm text-ink-soft">{label}</span>
      <span className="flex items-center gap-2">
        <span className={cn('tabular text-sm font-medium', state === 'fail' && 'text-critical')}>
          {value}
        </span>
        {state === 'ok' && <Check className="h-4 w-4 text-positive" aria-hidden />}
        {state === 'fail' && <X className="h-4 w-4 text-critical" aria-hidden />}
        {state === 'pending' && <Loader2 className="h-4 w-4 animate-spin text-ink-muted" aria-hidden />}
      </span>
    </div>
  );
}

export default function SystemStatus() {
  const [waking, setWaking] = useState(false);

  useEffect(() => onColdStart(setWaking), []);

  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => apiGet<HealthPayload>('/health'),
    refetchInterval: 30_000,
  });

  const dbHealth = useQuery({
    queryKey: ['health', 'db'],
    queryFn: () => apiGet<DbHealthPayload>('/health/db'),
    refetchInterval: 60_000,
    retry: 1,
  });

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-5 py-12">
      <header className="mb-8 animate-fade-up">
        <div className="mb-5 flex items-center gap-3">
          <img src={defaultBranding.logoUrl} alt="" className="h-11 w-11 rounded-xl" />
          <div>
            <h1 className="text-2xl leading-tight">{defaultBranding.name}</h1>
            <p className="text-sm italic text-ink-muted">…{defaultBranding.tagline}</p>
          </div>
        </div>
        <p className="eyebrow mb-1">Step 1 · foundation</p>
        <p className="text-sm leading-relaxed text-ink-soft">
          The monorepo is scaffolded and the API contract is live. Dashboards, auth and the AI layer
          arrive in the phased builds.
        </p>
      </header>

      {waking && (
        <div className="notice notice-caution mb-4">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
          <p>
            Waking the server. Free Render instances sleep when idle, so the first request takes up to
            a minute.
          </p>
        </div>
      )}

      <section className="card animate-fade-up p-5" aria-labelledby="api-status">
        <h2 id="api-status" className="mb-1 flex items-center gap-2 text-base">
          <Activity className="h-4 w-4 text-brand" aria-hidden />
          API
        </h2>
        <p className="mb-3 break-all text-xs text-ink-muted">{env.apiBaseUrl}</p>
        <StatusRow
          label="Service"
          value={health.data?.status ?? (health.isPending ? 'checking' : 'unreachable')}
          state={health.isPending ? 'pending' : health.isError ? 'fail' : 'ok'}
        />
        <StatusRow
          label="Environment"
          value={health.data?.environment ?? '—'}
          state={health.isPending ? 'pending' : health.isError ? 'fail' : 'ok'}
        />
        <StatusRow
          label="Uptime"
          value={health.data ? `${health.data.uptimeSec}s` : '—'}
          state={health.isPending ? 'pending' : health.isError ? 'fail' : 'ok'}
        />
      </section>

      <section className="card mt-4 animate-fade-up p-5" aria-labelledby="db-status">
        <h2 id="db-status" className="mb-3 flex items-center gap-2 text-base">
          <Database className="h-4 w-4 text-brand" aria-hidden />
          Database &amp; services
        </h2>
        <StatusRow
          label="PostgreSQL"
          value={dbHealth.data?.database ?? (dbHealth.isPending ? 'checking' : 'unreachable')}
          state={dbHealth.isPending ? 'pending' : dbHealth.isError ? 'fail' : 'ok'}
        />
        <StatusRow
          label="Round trip"
          value={dbHealth.data ? `${dbHealth.data.latencyMs} ms` : '—'}
          state={dbHealth.isPending ? 'pending' : dbHealth.isError ? 'fail' : 'ok'}
        />
        <StatusRow
          label="AI provider"
          value={dbHealth.data?.aiProvider ?? '—'}
          state={dbHealth.isPending ? 'pending' : dbHealth.isError ? 'fail' : 'ok'}
        />
        <StatusRow
          label="Storage driver"
          value={dbHealth.data?.storageDriver ?? '—'}
          state={dbHealth.isPending ? 'pending' : dbHealth.isError ? 'fail' : 'ok'}
        />
      </section>

      {dbHealth.isError && (
        <p className="mt-4 text-sm text-ink-soft">
          The API is running but cannot reach Postgres. Check <code className="tabular">DATABASE_URL</code>{' '}
          in <code className="tabular">apps/api/.env</code>, then run{' '}
          <code className="tabular">npm run db:migrate</code>.
        </p>
      )}
    </main>
  );
}
