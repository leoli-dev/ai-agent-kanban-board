import { useCallback, useRef, useState } from 'react';
import { useT } from '../lib/i18n';
import { IconX } from './icons';

export function UploadDropzone({ files, onChange }: { files: File[]; onChange: (f: File[]) => void }) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const addFiles = useCallback(
    (incoming: FileList | null) => {
      if (!incoming) return;
      onChange([...files, ...Array.from(incoming)]);
    },
    [files, onChange],
  );

  return (
    <div>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
        className={`cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition-colors duration-150 ${
          dragOver ? 'border-accent-400 bg-accent-500/10' : 'border-ink-700 hover:border-ink-500'
        }`}
      >
        <p className="text-sm text-ink-300">{t('new.dropzone')}</p>
        <p className="mt-1 text-xs text-ink-500">{t('new.dropzoneHint')}</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {files.length > 0 && (
        <ul className="mt-2 space-y-1">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              className="flex items-center justify-between rounded-lg bg-ink-850 px-3 py-1.5 text-xs"
            >
              <span className="truncate font-mono text-ink-300">{f.name}</span>
              <button
                type="button"
                className="ml-2 text-ink-500 transition-colors hover:text-red-400"
                onClick={() => onChange(files.filter((_, j) => j !== i))}
              >
                <IconX width={13} height={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
