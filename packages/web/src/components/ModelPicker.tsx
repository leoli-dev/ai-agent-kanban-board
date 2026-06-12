import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../lib/i18n';

/**
 * Searchable model combobox: type to filter, click to pick, free text is a
 * custom model. Scales from 5 models to OpenRouter's full catalog.
 */
export function ModelPicker({
  models,
  value,
  onChange,
  placeholder,
}: {
  models: string[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    const terms = q.split(/\s+/);
    return models.filter((m) => terms.every((term) => m.toLowerCase().includes(term)));
  }, [models, query]);

  useEffect(() => setHighlight(0), [query, open]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  useEffect(() => {
    listRef.current
      ?.children[highlight]?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  function pick(model: string) {
    onChange(model);
    setQuery('');
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative max-w-md">
      <div className="flex items-center gap-1.5">
        <input
          value={open ? query : value}
          placeholder={value || placeholder || t('builder.model.search')}
          onFocus={() => {
            setOpen(true);
            setQuery('');
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHighlight((h) => Math.min(h + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (filtered[highlight]) pick(filtered[highlight]);
              else if (query.trim()) pick(query.trim());
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          className="input-base font-mono"
        />
      </div>

      {open && (
        <ul
          ref={listRef}
          className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-ink-700 bg-ink-900 py-1 shadow-2xl shadow-black/50"
        >
          {filtered.length === 0 && (
            <li className="px-3 py-2 text-xs text-ink-500">
              {query.trim()
                ? t('builder.model.useCustom', { model: query.trim() })
                : t('builder.model.noMatch')}
            </li>
          )}
          {query.trim() && !filtered.includes(query.trim()) && (
            <li>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(query.trim())}
                className="block w-full px-3 py-1.5 text-left font-mono text-xs text-accent-300 hover:bg-ink-800"
              >
                → {t('builder.model.useCustom', { model: query.trim() })}
              </button>
            </li>
          )}
          {filtered.slice(0, 400).map((m, i) => (
            <li key={m}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(m)}
                onMouseEnter={() => setHighlight(i)}
                className={`block w-full px-3 py-1.5 text-left font-mono text-xs transition-colors ${
                  i === highlight ? 'bg-ink-800 text-accent-200' : 'text-ink-200'
                } ${m === value ? 'font-semibold text-accent-300' : ''}`}
              >
                {m}
              </button>
            </li>
          ))}
          {filtered.length > 400 && (
            <li className="px-3 py-1.5 text-[11px] text-ink-500">
              +{filtered.length - 400} — {t('builder.model.refine')}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
