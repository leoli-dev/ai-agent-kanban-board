import { useCallback, useRef, useState } from 'react';

export function UploadDropzone({ files, onChange }: { files: File[]; onChange: (f: File[]) => void }) {
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
        className={`cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
          dragOver ? 'border-sky-500 bg-sky-500/10' : 'border-slate-700 hover:border-slate-500'
        }`}
      >
        <p className="text-sm text-slate-300">Drop files here or tap to select</p>
        <p className="mt-1 text-xs text-slate-500">Screenshots, images, PDFs, markdown, videos…</p>
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
              className="flex items-center justify-between rounded-lg bg-slate-800/60 px-3 py-1.5 text-xs"
            >
              <span className="truncate text-slate-300">{f.name}</span>
              <button
                type="button"
                className="ml-2 text-slate-500 hover:text-rose-400"
                onClick={() => onChange(files.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
