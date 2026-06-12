import { describe, expect, it } from 'vitest';
import { classifyOutput } from '../src/providers/failure-classifier.js';

const failedResult = (text: string) => ({ ok: false, text });

describe('failure classifier', () => {
  it('classifies subscription limit messages as QUOTA (fallback must trigger)', () => {
    const messages = [
      "You've hit your session limit · resets 4pm (America/Toronto)",
      "You've reached your usage limit",
      'You have reached your weekly limit',
      'Usage limit reached — upgrade your plan',
      '5-hour limit reached',
    ];
    for (const text of messages) {
      expect(classifyOutput(0, '', failedResult(text)), text).toBe('QUOTA');
    }
  });

  it('classifies API-style quota errors as QUOTA', () => {
    expect(classifyOutput(1, '', failedResult('API Error: 429 rate limit exceeded'))).toBe('QUOTA');
    expect(classifyOutput(1, '', failedResult('credit balance too low'))).toBe('QUOTA');
    expect(classifyOutput(1, 'HTTP 529 overloaded', undefined)).toBe('QUOTA');
  });

  it('does not misclassify ordinary task failures', () => {
    expect(classifyOutput(0, '', failedResult('Reached maximum number of turns'))).toBe('TASK_FAIL');
    expect(classifyOutput(0, '', failedResult('Tests failed: TypeError in game.js'))).toBe(
      'TASK_FAIL',
    );
  });

  it('auth failures and crashes keep their classes', () => {
    expect(classifyOutput(1, '', failedResult('401 invalid api key'))).toBe('AUTH');
    expect(classifyOutput(1, 'segfault', undefined)).toBe('CRASH');
  });
});
