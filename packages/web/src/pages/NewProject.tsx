import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Project } from '@akb/shared';
import { api, ApiError } from '../lib/api';
import { UploadDropzone } from '../components/UploadDropzone';

export default function NewProject() {
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

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6">
      <h1 className="mb-5 text-lg font-semibold">New Project</h1>
      <div className="space-y-5">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-300">Your idea / task *</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={6}
            placeholder="Describe what you want built. The planner agent will refine it and ask follow-up questions if needed."
            className="w-full rounded-xl border border-slate-700 bg-slate-900 p-3 text-sm outline-none placeholder:text-slate-600 focus:border-sky-500"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-300">
            Target repo path * <span className="font-normal text-slate-500">(local git repo the agents will work in)</span>
          </span>
          <input
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="/Users/leo/Code/my-project"
            className="w-full rounded-xl border border-slate-700 bg-slate-900 p-3 font-mono text-sm outline-none placeholder:text-slate-600 focus:border-sky-500"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-300">
            Project name <span className="font-normal text-slate-500">(optional)</span>
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Derived from the prompt if empty"
            className="w-full rounded-xl border border-slate-700 bg-slate-900 p-3 text-sm outline-none placeholder:text-slate-600 focus:border-sky-500"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-300">
            Reference links <span className="font-normal text-slate-500">(one URL per line)</span>
          </span>
          <textarea
            value={links}
            onChange={(e) => setLinks(e.target.value)}
            rows={2}
            placeholder={'https://example.com/docs\nhttps://github.com/some/repo'}
            className="w-full rounded-xl border border-slate-700 bg-slate-900 p-3 font-mono text-xs outline-none placeholder:text-slate-600 focus:border-sky-500"
          />
        </label>

        <div>
          <span className="mb-1 block text-sm font-medium text-slate-300">Resource files</span>
          <UploadDropzone files={files} onChange={setFiles} />
        </div>

        {error && (
          <p className="rounded-lg border border-rose-800 bg-rose-950/50 p-3 text-sm text-rose-300">
            {error}
          </p>
        )}

        <button
          onClick={submit}
          disabled={busy || !prompt.trim() || !repoPath.trim()}
          className="w-full rounded-xl bg-sky-600 py-3 text-sm font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Creating…' : 'Create project'}
        </button>
      </div>
    </div>
  );
}
