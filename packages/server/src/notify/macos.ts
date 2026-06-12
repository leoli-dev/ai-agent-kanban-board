import { spawn } from 'node:child_process';

/** Native macOS banner via osascript. Args are passed as AppleScript string
 * literals (JSON escaping is compatible); never shell-interpolated. */
export function macosNotify(title: string, body: string): void {
  if (process.platform !== 'darwin') return;
  const script = `display notification ${JSON.stringify(body.slice(0, 300))} with title ${JSON.stringify(title.slice(0, 100))} sound name "Glass"`;
  const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
  child.on('error', () => {});
}
