import type { FailureClass } from '@akb/shared';
import type { NormalizedResult } from '../engines/types.js';

const QUOTA_RE =
  /credit balance|insufficient (credits|quota|funds)|exceeded.*quota|quota.*exceeded|rate.?limit|too many requests|\b429\b|\b529\b|overloaded/i;
const AUTH_RE = /\b401\b|\b403\b|invalid.*(api.?key|token)|authentication|unauthorized|forbidden/i;

/**
 * Shared text-based classification used by engine adapters. Order matters:
 * quota before auth (some 429 bodies mention keys), both before generic crash.
 */
export function classifyOutput(
  exitCode: number | null,
  stderrTail: string,
  lastResult?: NormalizedResult,
): FailureClass {
  if (lastResult?.ok && (exitCode === 0 || exitCode === null)) return 'OK';

  const haystack = `${lastResult?.text ?? ''}\n${stderrTail}`;
  if (QUOTA_RE.test(haystack)) return 'QUOTA';
  if (AUTH_RE.test(haystack)) return 'AUTH';

  // Engine completed its protocol but the task itself failed.
  if (lastResult && !lastResult.ok) return 'TASK_FAIL';
  // No result event at all: the process died before finishing.
  return 'CRASH';
}
