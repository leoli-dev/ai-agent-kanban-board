#!/usr/bin/env node
/**
 * Mock agent engine for tests and token-free pipeline development.
 * Reads a script from the MOCK_SCRIPT env var (JSON):
 *   {
 *     "events": [{ "delayMs": 10, "line": { ...claude stream-json object... } }],
 *     "exitCode": 0,
 *     "stallMs": 0,        // sleep this long after events before exiting
 *     "writeFiles": [{ "path": "...", "content": "..." }],
 *     "stderr": "text to emit on stderr before exit"
 *   }
 * Emits claude-style stream-json lines so the mock adapter can reuse the
 * claude-code parser. Ignores argv (prompt etc.).
 */
const fs = require('node:fs');
const path = require('node:path');

let script = JSON.parse(process.env.MOCK_SCRIPT || '{"events":[],"exitCode":0}');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Multi-phase mode: {"phases":[script...],"stateFile":"/path"} plays one
// phase per invocation, tracked via a counter file (for multi-turn flows).
if (script.phases) {
  let n = 0;
  try {
    n = parseInt(fs.readFileSync(script.stateFile, 'utf8'), 10) || 0;
  } catch {}
  fs.mkdirSync(path.dirname(script.stateFile), { recursive: true });
  fs.writeFileSync(script.stateFile, String(n + 1));
  script = script.phases[Math.min(n, script.phases.length - 1)];
}

(async () => {
  for (const ev of script.events || []) {
    if (ev.delayMs) await sleep(ev.delayMs);
    process.stdout.write(JSON.stringify(ev.line) + '\n');
  }
  for (const f of script.writeFiles || []) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.content);
  }
  if (script.stderr) process.stderr.write(script.stderr);
  if (script.stallMs) await sleep(script.stallMs);
  process.exit(script.exitCode || 0);
})();
