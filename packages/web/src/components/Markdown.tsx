import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Shared markdown renderer with GFM (tables, strikethrough, task lists). */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm prose-invert max-w-none prose-headings:tracking-tight prose-table:text-xs prose-th:text-ink-300 prose-td:border-ink-800 prose-th:border-ink-700">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
