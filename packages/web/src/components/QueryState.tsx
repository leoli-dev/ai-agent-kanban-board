import { useT } from '../lib/i18n';
import { IconRetry, IconWarn } from './icons';

/** Shared loading / error rendering so failed fetches never look like
 * eternal loading. */
export function Loading() {
  const t = useT();
  return (
    <div className="flex items-center justify-center gap-2.5 p-12 text-sm text-ink-400">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-700 border-t-accent-400" />
      {t('common.loading')}
    </div>
  );
}

export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return (
    <div className="mx-auto max-w-md p-10 text-center">
      <IconWarn className="mx-auto mb-3 text-red-400" width={28} height={28} />
      <p className="text-sm font-medium text-ink-100">Couldn't load this page</p>
      <p className="mt-1 break-words font-mono text-xs text-ink-400">{message}</p>
      <p className="mt-1 text-xs text-ink-500">Is the server running?</p>
      <button onClick={onRetry} className="btn btn-ghost mx-auto mt-4 px-4 py-2 text-sm">
        <IconRetry width={15} height={15} /> Retry
      </button>
    </div>
  );
}
