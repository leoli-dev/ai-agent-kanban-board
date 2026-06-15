import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectRunPlan, normalizeUrl } from '../src/runner/project-runner.js';

function tmpRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-run-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

describe('detectRunPlan', () => {
  it('uses the dev script (no build) for a Vite-style app and picks pnpm by lockfile', () => {
    const dir = tmpRepo({
      'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }),
      'pnpm-lock.yaml': '',
    });
    const plan = detectRunPlan(dir)!;
    expect(plan.command).toBe('pnpm install && pnpm dev');
    expect(plan.label).toBe('pnpm dev');
  });

  it('builds before a preview/start script that serves build output', () => {
    const dir = tmpRepo({
      'package.json': JSON.stringify({ scripts: { build: 'vite build', preview: 'vite preview' } }),
    });
    const plan = detectRunPlan(dir)!;
    expect(plan.command).toBe('npm install && npm run build && npm run preview');
  });

  it('falls back to a static server for a plain index.html', () => {
    const dir = tmpRepo({ 'index.html': '<h1>hi</h1>' });
    expect(detectRunPlan(dir)!.command).toBe('python3 -m http.server "$PORT"');
  });

  it('returns null when there is nothing runnable', () => {
    expect(detectRunPlan(tmpRepo({ 'README.md': '# x' }))).toBeNull();
    expect(detectRunPlan(tmpRepo({ 'package.json': JSON.stringify({ scripts: {} }) }))).toBeNull();
  });
});

describe('normalizeUrl', () => {
  it('rewrites bind-all hosts to localhost', () => {
    expect(normalizeUrl('http://0.0.0.0:5173/', 5173)).toBe('http://localhost:5173/');
    expect(normalizeUrl('http://127.0.0.1:3000', 3000)).toBe('http://localhost:3000');
    expect(normalizeUrl('http://[::1]:8080/app', 8080)).toBe('http://localhost:8080/app');
  });

  it('adds the known port when the matched URL has none, and trims trailing punctuation', () => {
    expect(normalizeUrl('http://localhost', 4321)).toBe('http://localhost:4321');
    expect(normalizeUrl('http://localhost:5173).', 5173)).toBe('http://localhost:5173');
  });
});
