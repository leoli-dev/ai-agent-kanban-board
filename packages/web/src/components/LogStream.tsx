import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWsTopics } from '../lib/ws';

interface LogLine {
  key: string;
  kind: string;
  text: string;
}

function parseNdjson(raw: string): LogLine[] {
  const lines: LogLine[] = [];
  let i = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    i++;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      lines.push(renderEvent(obj, `h-${i}`));
    } catch {
      lines.push({ key: `h-${i}`, kind: 'raw', text: line.slice(0, 500) });
    }
  }
  return lines.filter((l) => l.text);
}

function renderEvent(obj: Record<string, unknown>, key: string): LogLine {
  const type = obj.type as string;
  if (type === 'akb-meta') {
    return { key, kind: 'meta', text: `▶ ${obj.role as string} run via ${obj.profile as string} (${obj.engine as string})` };
  }
  if (type === 'akb-stderr') return { key, kind: 'stderr', text: String(obj.text ?? '').trim() };
  if (type === 'system') return { key, kind: 'meta', text: 'session started' };
  if (type === 'result') {
    const err = obj.is_error ? ' (error)' : '';
    return { key, kind: 'result', text: `■ result${err}: ${String(obj.result ?? '').slice(0, 2000)}` };
  }
  if (type === 'assistant') {
    const msg = obj.message as { content?: { type?: string; text?: string; name?: string }[] } | undefined;
    const content = msg?.content ?? [];
    const tool = content.find((c) => c.type === 'tool_use');
    if (tool?.name) return { key, kind: 'tool', text: `⚙ ${tool.name}` };
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    return { key, kind: 'text', text };
  }
  return { key, kind: 'raw', text: '' };
}

const kindStyle: Record<string, string> = {
  meta: 'text-slate-500',
  text: 'text-slate-200',
  tool: 'text-sky-400',
  stderr: 'text-rose-400',
  result: 'text-emerald-300',
  raw: 'text-slate-600',
};

export function LogStream({ runId, active }: { runId: string; active: boolean }) {
  const [liveLines, setLiveLines] = useState<LogLine[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const { data: history = [] } = useQuery({
    queryKey: ['runLog', runId],
    queryFn: async () => {
      const res = await fetch(`/api/runs/${runId}/log`);
      return parseNdjson(await res.text());
    },
    refetchInterval: active ? false : undefined,
  });

  useEffect(() => setLiveLines([]), [runId]);

  useWsTopics(active ? [`run:${runId}`] : [], (msg) => {
    if (msg.type === 'run.event' && msg.runId === runId) {
      const e = msg.event;
      const text =
        e.kind === 'tool' ? `⚙ ${e.tool ?? ''}` : e.kind === 'result' ? `■ ${e.text ?? ''}` : (e.text ?? '');
      if (!text) return;
      setLiveLines((prev) => [
        ...prev.slice(-500),
        { key: `l-${e.ts}-${prev.length}`, kind: e.kind, text },
      ]);
    }
  });

  const lines = [...history, ...liveLines];

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines.length, autoScroll]);

  return (
    <div
      ref={containerRef}
      onScroll={() => {
        const el = containerRef.current;
        if (!el) return;
        setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
      }}
      className="h-80 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950 p-3 font-mono text-xs leading-relaxed"
    >
      {lines.length === 0 ? (
        <p className="text-slate-600">No log output yet…</p>
      ) : (
        lines.map((l) => (
          <p key={l.key} className={`whitespace-pre-wrap break-words ${kindStyle[l.kind] ?? 'text-slate-300'}`}>
            {l.text}
          </p>
        ))
      )}
    </div>
  );
}
