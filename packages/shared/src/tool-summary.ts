/**
 * A concise one-line label for an agent tool call, derived from the tool name
 * and its input — so logs show "Bash · npm install" / "Write · src/App.tsx"
 * instead of a bare "Bash". Shared by the engine adapters (live events) and the
 * web log viewer (history) so both render identically.
 */
export function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  let detail = '';
  switch (name) {
    case 'Bash':
    case 'shell':
      detail = str(i.command);
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      detail = str(i.file_path) || str(i.path) || str(i.notebook_path);
      break;
    case 'Grep':
      detail = str(i.pattern) + (str(i.path) ? ` (${str(i.path)})` : '');
      break;
    case 'Glob':
      detail = str(i.pattern);
      break;
    case 'Task':
      detail = str(i.description) || str(i.prompt);
      break;
    case 'WebFetch':
    case 'WebSearch':
      detail = str(i.url) || str(i.query);
      break;
    default: {
      const firstString = Object.values(i).find((v) => typeof v === 'string' && v.length > 0);
      detail = str(firstString);
    }
  }
  return detail.replace(/\s+/g, ' ').trim().slice(0, 240);
}
