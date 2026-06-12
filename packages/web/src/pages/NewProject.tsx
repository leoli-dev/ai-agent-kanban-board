import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Project } from '@akb/shared';
import { api, ApiError } from '../lib/api';
import { useT } from '../lib/i18n';
import { UploadDropzone } from '../components/UploadDropzone';

export default function NewProject() {
  const t = useT();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [links, setLinks] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        targetRepoPath: repoPath,
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
            {t('new.repo')} * <span className="font-normal text-ink-500">— {t('new.repoHint')}</span>
          </span>
          <input
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="/Users/leo/Code/my-project"
            className="input-base font-mono"
          />
        </label>

        <label className="block">
          <span className={label}>
            {t('new.name')}
            {optional}
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('new.namePlaceholder')}
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
          disabled={busy || !prompt.trim() || !repoPath.trim()}
          className="btn btn-primary w-full py-3 text-sm font-semibold"
        >
          {busy ? t('new.creating') : t('new.create')}
        </button>
      </div>
    </div>
  );
}
