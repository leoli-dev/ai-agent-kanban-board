import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Project, Settings } from '@akb/shared';
import { api, ApiError } from '../lib/api';
import { useT } from '../lib/i18n';
import { UploadDropzone } from '../components/UploadDropzone';

export default function NewProject() {
  const t = useT();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [repoName, setRepoName] = useState('');
  const [links, setLinks] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Settings>('/api/settings'),
  });
  const defaultDir = (settings?.defaultProjectDir ?? '~/Code').replace(/\/+$/, '');
  const trimmedRepo = repoName.trim();
  const repoValid = !!trimmedRepo && !/[/\\]/.test(trimmedRepo) && !trimmedRepo.includes('..');

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const linkList = links
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const project = await api.post<Project>('/api/projects', {
        prompt,
        name: name || undefined,
        repoName: trimmedRepo,
        links: linkList,
      });
      if (files.length) {
        const form = new FormData();
        for (const f of files) form.append('files', f);
        await api.upload(`/api/projects/${project.id}/inputs`, form);
      }
      navigate(`/projects/${project.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const label = 'mb-1 block text-sm font-medium text-ink-300';
  const optional = <span className="font-normal text-ink-500"> · {t('new.nameOptional')}</span>;

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6">
      <h1 className="mb-5 text-xl font-semibold tracking-tight">{t('new.title')}</h1>
      <div className="space-y-5">
        <label className="block">
          <span className={label}>{t('new.idea')} *</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={6}
            placeholder={t('new.ideaPlaceholder')}
            className="input-base"
          />
        </label>

        <label className="block">
          <span className={label}>
            {t('new.repoName')} *{' '}
            <span className="font-normal text-ink-500">— {t('new.repoNameHint')}</span>
          </span>
          <div
            className={`flex items-stretch overflow-hidden rounded-lg border bg-ink-900 font-mono focus-within:border-accent-500/60 ${
              trimmedRepo && !repoValid ? 'border-red-800' : 'border-ink-700'
            }`}
          >
            <span className="flex shrink-0 items-center whitespace-nowrap border-r border-ink-800 bg-ink-850 px-3 py-2 text-sm text-ink-500">
              {defaultDir}/
            </span>
            <input
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
              placeholder="my-project"
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-ink-100 outline-none"
            />
          </div>
          <p className="mt-1 text-[11px] text-ink-500">
            {trimmedRepo && !repoValid ? (
              <span className="text-red-400">{t('new.repoNameInvalid')}</span>
            ) : (
              <>
                {t('new.repoChangeDefault')}{' '}
                <span className="font-mono text-ink-400">
                  {defaultDir}/{trimmedRepo || 'my-project'}
                </span>
              </>
            )}
          </p>
        </label>

        <label className="block">
          <span className={label}>
            {t('new.name')}
            {optional}
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={trimmedRepo || t('new.namePlaceholder')}
            className="input-base"
          />
        </label>

        <label className="block">
          <span className={label}>
            {t('new.links')} <span className="font-normal text-ink-500">— {t('new.linksHint')}</span>
          </span>
          <textarea
            value={links}
            onChange={(e) => setLinks(e.target.value)}
            rows={2}
            placeholder={'https://example.com/docs'}
            className="input-base font-mono text-xs"
          />
        </label>

        <div>
          <span className={label}>{t('new.files')}</span>
          <UploadDropzone files={files} onChange={setFiles} />
        </div>

        {error && (
          <p className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-300">
            {error}
          </p>
        )}

        <button
          onClick={submit}
          disabled={busy || !prompt.trim() || !repoValid}
          className="btn btn-primary w-full py-3 text-sm font-semibold"
        >
          {busy ? t('new.creating') : t('new.create')}
        </button>
      </div>
    </div>
  );
}
