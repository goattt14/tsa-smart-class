import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge, toneForStatus } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States';
import { apiGet, apiPost, ApiError } from '../../lib/api-client';
import { keys } from '../../hooks/useApi';
import { relativeDay, subjectColor } from '../../lib/format';
import { useAuth } from '../../auth/AuthProvider';

interface Material {
  id: string;
  title: string;
  description: string | null;
  type: string;
  visibility: string;
  isCurriculumApproved: boolean;
  ingestStatus: string;
  chunkCount: number;
  createdAt: string;
  subject: { id: string; name: string; colorHex: string | null };
  batch: { id: string; name: string } | null;
  files: { id: string; originalName: string; sizeBytes: number }[];
}

interface Subject {
  id: string;
  name: string;
  colorHex: string | null;
}

interface Batch {
  id: string;
  name: string;
  code: string;
}

export function MaterialsPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [showUpload, setShowUpload] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [batchId, setBatchId] = useState('');
  const [type, setType] = useState('TEXT');
  const [rawText, setRawText] = useState('');
  const [visibility, setVisibility] = useState('BATCH');
  const [isApproved, setIsApproved] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const canUpload = can('materials.upload');

  const materialsQuery = useQuery({
    queryKey: keys.materials,
    queryFn: async () => {
      const result = await apiGet<any>('/materials?pageSize=50');
      if (Array.isArray(result)) return { items: result as Material[] };
      if (result && Array.isArray(result.items)) return { items: result.items as Material[] };
      if (result && Array.isArray(result.data)) return { items: result.data as Material[] };
      return { items: [] as Material[] };
    },
  });

  const subjectsQuery = useQuery({
    queryKey: ['subjects'],
    queryFn: async () => {
      const result = await apiGet<any>('/academics/subjects?pageSize=50');
      if (Array.isArray(result)) return { items: result as Subject[] };
      if (result && Array.isArray(result.items)) return { items: result.items as Subject[] };
      return { items: [] as Subject[] };
    },
  });

  const batchesQuery = useQuery({
    queryKey: ['batches'],
    queryFn: async () => {
      const result = await apiGet<any>('/academics/batches?pageSize=50');
      if (Array.isArray(result)) return { items: result as Batch[] };
      if (result && Array.isArray(result.items)) return { items: result.items as Batch[] };
      if (result && result.batches) return { items: result.batches as Batch[] };
      return { items: [] as Batch[] };
    },
    enabled: showUpload,
  });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      // Use FormData for multipart upload
      const formData = new FormData();
      formData.append('title', title);
      formData.append('description', description);
      formData.append('subjectId', subjectId);
      if (batchId) formData.append('batchId', batchId);
      formData.append('type', type);
      formData.append('visibility', visibility);
      formData.append('isCurriculumApproved', String(isApproved));
      if (rawText) formData.append('rawText', rawText);

      // Use fetch directly for FormData
      const { apiClient } = await import('../../lib/api-client');
      const response = await apiClient.post('/materials', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return response.data;
    },
    onSuccess: () => {
      setMessage('✅ Material uploaded! It will be indexed for Viva grounding.');
      setTitle('');
      setDescription('');
      setRawText('');
      setShowUpload(false);
      queryClient.invalidateQueries({ queryKey: keys.materials });
    },
    onError: (error) => {
      setMessage(error instanceof ApiError ? `❌ ${error.message}` : '❌ Upload failed');
    },
  });

  const indexMutation = useMutation({
    mutationFn: (materialId: string) => apiPost(`/ai/materials/${materialId}/index`),
    onSuccess: () => {
      setMessage('✅ Material indexed! Now Viva can use it.');
      queryClient.invalidateQueries({ queryKey: keys.materials });
    },
  });

  if (materialsQuery.isPending) return <Card><CardBody><Skeleton rows={5} /></CardBody></Card>;
  if (materialsQuery.isError || !materialsQuery.data) return <Card><CardBody><ErrorState error={materialsQuery.error} onRetry={() => materialsQuery.refetch()} /></CardBody></Card>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[27px] font-semibold leading-tight text-ink">Study Material</h1>
          <p className="mt-1 text-[13px] text-ink-muted">Teacher notes grounded source for AI Viva & practice questions</p>
        </div>
        {canUpload && (
          <Button size="sm" onClick={() => setShowUpload(!showUpload)}>
            {showUpload ? 'Cancel' : '📤 Upload Notes'}
          </Button>
        )}
      </div>

      {message && (
        <div className="rounded-lg border border-line bg-surface-raised px-4 py-3 text-[13px]">{message}</div>
      )}

      {showUpload && canUpload && (
        <Card>
          <CardHeader title="Upload Study Material" hint="Text material is easiest for Viva grounding - no file needed" />
          <CardBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Newton's Laws - Class 10" required />
              <div>
                <label className="mb-1.5 block text-[13px] font-semibold">Subject *</label>
                <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} className="h-11 w-full rounded-lg border border-line bg-surface-raised px-3.5 text-[14px]">
                  <option value="">Select subject</option>
                  {(subjectsQuery.data?.items || []).map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-semibold">Description</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short description of what this covers" className="w-full rounded-lg border border-line bg-surface-raised px-3.5 py-2.5 text-[14px]" rows={2} />
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="mb-1.5 block text-[13px] font-semibold">Batch (optional)</label>
                <select value={batchId} onChange={(e) => setBatchId(e.target.value)} className="h-11 w-full rounded-lg border border-line bg-surface-raised px-3.5 text-[14px]">
                  <option value="">All batches (Institute level)</option>
                  {(batchesQuery.data?.items || []).map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-[13px] font-semibold">Type</label>
                <select value={type} onChange={(e) => setType(e.target.value)} className="h-11 w-full rounded-lg border border-line bg-surface-raised px-3.5 text-[14px]">
                  <option value="TEXT">TEXT (easiest - type notes)</option>
                  <option value="PDF">PDF</option>
                  <option value="IMAGE">IMAGE</option>
                  <option value="LINK">LINK</option>
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-[13px] font-semibold">Visibility</label>
                <select value={visibility} onChange={(e) => setVisibility(e.target.value)} className="h-11 w-full rounded-lg border border-line bg-surface-raised px-3.5 text-[14px]">
                  <option value="BATCH">BATCH (default)</option>
                  <option value="INSTITUTE">INSTITUTE (all)</option>
                  <option value="PRIVATE">PRIVATE (draft)</option>
                </select>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-semibold">Notes Content (for TEXT type) *</label>
              <textarea value={rawText} onChange={(e) => setRawText(e.target.value)} placeholder="Paste your lecture notes here... This becomes grounded source for Viva. Example: Newton's First Law states that an object at rest stays at rest..." className="w-full rounded-lg border border-line bg-surface-raised px-3.5 py-3 text-[14px] leading-relaxed" rows={8} required />
              <p className="mt-1 text-[11px] text-ink-muted">Tip: At least 100 characters needed for indexing. More detailed notes = better Viva questions!</p>
            </div>

            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={isApproved} onChange={(e) => setIsApproved(e.target.checked)} />
              <span>Mark as <strong>Curriculum Approved</strong> (required for Viva grounding) ✅</span>
            </label>

            <Button loading={uploadMutation.isPending} disabled={!title || !subjectId || !rawText} onClick={() => uploadMutation.mutate()}>
              Upload & Index for Viva
            </Button>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Available to You" hint={`${materialsQuery.data.items.length} materials • Indexed = Viva can use it`} />
        {materialsQuery.data.items.length === 0 ? (
          <CardBody><EmptyState title="No notes yet" body="Upload notes as teacher to test Viva. For quick test, run demo seed in Codespaces: npm run db:seed:materials" /></CardBody>
        ) : (
          <ul className="divide-y divide-line">
            {materialsQuery.data.items.map((item) => (
              <li key={item.id} className="flex items-start gap-3 px-5 py-3.5">
                <span className="mt-1 h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: subjectColor(item.subject.colorHex) }} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14.5px] font-medium text-ink">{item.title}</p>
                  {item.description && <p className="mt-0.5 line-clamp-2 text-[13px] text-ink-muted">{item.description}</p>}
                  <p className="mt-1 text-[12px] text-ink-muted">
                    {item.subject.name} • {item.type.toLowerCase()} • {item.visibility.toLowerCase()} • {item.files.length} files • {relativeDay(item.createdAt)}
                    {item.isCurriculumApproved && <span className="ml-2 text-positive">✓ Approved</span>}
                  </p>
                </div>
                <div className="shrink-0 flex flex-col items-end gap-2">
                  <Badge tone={toneForStatus(item.ingestStatus === 'INDEXED' ? 'COMPLETED' : item.ingestStatus)}>{item.ingestStatus.toLowerCase()}</Badge>
                  {item.chunkCount > 0 && <p className="font-mono text-[11px] text-ink-muted">{item.chunkCount} chunks</p>}
                  {item.ingestStatus !== 'INDEXED' && canUpload && (
                    <Button size="sm" variant="secondary" loading={indexMutation.isPending} onClick={() => indexMutation.mutate(item.id)}>Index for Viva</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="rounded-lg border border-line bg-surface-raised p-4">
        <h3 className="font-semibold text-[14px]">How Materials Enable Viva</h3>
        <p className="mt-1 text-[13px] text-ink-soft">1. Teacher uploads notes (TEXT type easiest) with "Curriculum Approved" checked → 2. System chunks into 900-token pieces → 3. Embeds via AI (mock works) → 4. Marks INDEXED → 5. Viva generates grounded questions ONLY from these notes, cites source passage → 6. Student answers via voice/text → AI evaluates with what went right/wrong/why/correct approach</p>
      </div>
    </div>
  );
}
