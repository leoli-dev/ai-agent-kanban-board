import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { summarizeToolInput } from '@akb/shared';
import { useWsTopics } from '../lib/ws';
import { useT } from '../lib/i18n';

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
    return {
      key,
      kind: 'meta',
      text: `▶ ${obj.role as string} · ${obj.profile as string} (${obj.engine as string})`,
    };
  }
  if (type === 'akb-stderr') return { key, kind: 'stderr', text: String(obj.text ?? '').trim() };
  if (type === 'system') {
    // Only the init event is interesting; verbose mode emits many others.
    return { key, kind: 'meta', text: obj.subtype === 'init' ? '● session started' : '' };
  }
  if (type === 'result') {
    const err = obj.is_error ? ' (error)' : '';
    return { key, kind: 'result', text: `■ result${err}: ${String(obj.result ?? '').slice(0, 2000)}` };
  }
  if (type === 'assistant') {
    const msg = obj.message as
      | { content?: { type?: string; text?: string; name?: string; input?: unknown }[] }
      | undefined;
    const content = msg?.content ?? [];
    const tool = content.find((c) => c.type === 'tool_use');
    if (tool?.name) {
      const detail = summarizeToolInput(tool.name, tool.input);
      return { key, kind: 'tool', text: `⚙ ${tool.name}${detail ? ` · ${detail}` : ''}` };
    }
    const text = content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    return { key, kind: 'text', text };
  }

  // Codex (`codex exec --json`) JSONL shapes — its log lines look nothing like
  // claude-code's, so without this the whole codex run renders blank.
  if (type === 'thread.started') return { key, kind: 'meta', text: '● session started' };
  if (type === 'item.completed') {
    const item = obj.item as
      | { type?: string; text?: string; command?: string; changes?: { path?: string; kind?: string }[] }
      | undefined;
    if (item?.type === 'agent_message' && item.text) return { key, kind: 'text', text: item.text };
    if (item?.type === 'command_execution') {
      const cmd = (item.command ?? '').replace(/\s+/g, ' ').slice(0, 300);
      return { key, kind: 'tool', text: `⚙ shell${cmd ? ` · ${cmd}` : ''}` };
    }
    if (item?.type === 'file_change') {
      const files = (item.changes ?? [])
        .map((c) => `${c.kind ?? 'edit'} ${(c.path ?? '').split('/').pop()}`)
        .join(', ');
      return { key, kind: 'tool', text: `✎ ${files || 'file change'}` };
    }
    return { key, kind: 'raw', text: '' };
  }
  if (type === 'turn.failed' || type === 'error') {
    const err = obj.error as { message?: string } | undefined;
    return {
      key,
      kind: 'result',
      text: `■ result (error): ${err?.message ?? String(obj.message ?? 'codex run failed')}`,
    };
  }
  // Legacy codex {id, msg:{...}} shape.
  const legacy = obj.msg as { type?: string; message?: string; last_agent_message?: string } | undefined;
  if (legacy?.type) {
    if (legacy.type === 'agent_message' && legacy.message)
      return { key, kind: 'text', text: legacy.message };
    if (legacy.type === 'error')
      return { key, kind: 'result', text: `■ result (error): ${legacy.message ?? 'codex error'}` };
    return { key, kind: 'raw', text: '' };
  }
  return { key, kind: 'raw', text: '' };
}

const kindStyle: Record<string, string> = {
  meta: 'text-ink-500',
  text: 'text-ink-200',
  tool: 'text-accent-300',
  stderr: 'text-red-400',
  result: 'text-teal-300',
  raw: 'text-ink-600',
};

export function LogStream({ runId, active }: { runId: string; active: boolean }) {
  const t = useT();
  const [liveLines, setLiveLines] = useState<LogLine[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const { data: history = [] } = useQuery({
    queryKey: ['runLog', runId],
    queryFn: async () => {
      const res = await fetch(`/api/runs/${runId}/log`);
      return parseNdjson(await res.text());
    },
  });

  useEffect(() => setLiveLines([]), [runId]);

  useWsTopics(active ? [`run:${runId}`] : [], (msg) => {
    if (msg.type === 'run.event' && msg.runId === runId) {
      const e = msg.event;
      const text =
        e.kind === 'tool'
          ? `⚙ ${e.tool ?? ''}${e.detail ? ` · ${e.detail}` : ''}`
          : e.kind === 'result'
            ? `■ ${e.text ?? ''}`
            : (e.text ?? '');
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
      className="h-80 overflow-y-auto rounded-xl border border-ink-800 bg-ink-950 p-3 font-mono text-xs leading-relaxed"
    >
      {lines.length === 0 ? (
        <p className="text-ink-600">{t('task.noLog')}</p>
      ) : (
        lines.map((l) => (
          <p
            key={l.key}
            className={`whitespace-pre-wrap break-words ${kindStyle[l.kind] ?? 'text-ink-300'}`}
          >
            {l.text}
          </p>
        ))
      )}
    </div>
  );
}
