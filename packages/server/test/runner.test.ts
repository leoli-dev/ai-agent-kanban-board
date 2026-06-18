import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { addMockProfile, makeTestCtx, scripts } from './helpers.js';

const baseReq = (ctx: ReturnType<typeof makeTestCtx>) => ({
  role: 'coder' as const,
  prompt: 'do the thing',
  cwd: ctx.tmpDir,
  logDir: path.join(ctx.tmpDir, 'logs'),
});

describe('AgentRunner', () => {
  it('runs a successful attempt and records usage', async () => {
    const ctx = makeTestCtx();
    addMockProfile(ctx, 'coder', scripts.success('all good'));

    const outcome = await ctx.runner.run(baseReq(ctx));

    expect(outcome.ok).toBe(true);
    expect(outcome.failureClass).toBe('OK');
    expect(outcome.attempts).toHaveLength(1);
    const run = outcome.finalRun!;
    expect(run.status).toBe('succeeded');
    expect(run.engineSessionId).toMatch(/^sess-/);
    expect(run.costUsd).toBe(0.01);
    expect(run.inputTokens).toBe(100);
    expect(run.resultText).toBe('all good');
  });

  it('falls back to the next provider on quota exhaustion and cools the first down', async () => {
    const ctx = makeTestCtx();
    const quotaProfile = addMockProfile(ctx, 'coder', scripts.quota());
    addMockProfile(ctx, 'coder', scripts.success());

    const outcome = await ctx.runner.run(baseReq(ctx));

    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts[0]!.failureClass).toBe('QUOTA');
    expect(outcome.attempts[1]!.failureClass).toBe('OK');
    const cooled = ctx.registry.get(quotaProfile.id)!;
    expect(cooled.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it('disables a provider permanently on auth failure', async () => {
    const ctx = makeTestCtx();
    const authProfile = addMockProfile(ctx, 'coder', scripts.auth());
    addMockProfile(ctx, 'coder', scripts.success());

    const outcome = await ctx.runner.run(baseReq(ctx));

    expect(outcome.ok).toBe(true);
    const disabled = ctx.registry.get(authProfile.id)!;
    expect(disabled.enabled).toBe(false);
    expect(disabled.disabledReason).toContain('auth');
  });

  it('retries a crashing provider once before falling back', async () => {
    const ctx = makeTestCtx();
    addMockProfile(ctx, 'coder', scripts.crash());
    addMockProfile(ctx, 'coder', scripts.success());

    const outcome = await ctx.runner.run(baseReq(ctx));

    expect(outcome.ok).toBe(true);
    // crash, crash retry, fallback success
    expect(outcome.attempts).toHaveLength(3);
    expect(outcome.attempts[0]!.failureClass).toBe('CRASH');
    expect(outcome.attempts[1]!.failureClass).toBe('CRASH');
    expect(outcome.attempts[2]!.failureClass).toBe('OK');
  });

  it('does not fall back on task-level failure (error_max_turns)', async () => {
    const ctx = makeTestCtx();
    addMockProfile(ctx, 'coder', scripts.taskFail());
    addMockProfile(ctx, 'coder', scripts.success());

    const outcome = await ctx.runner.run(baseReq(ctx));

    expect(outcome.ok).toBe(false);
    expect(outcome.failureClass).toBe('TASK_FAIL');
    expect(outcome.blocked).toBe(false);
    expect(outcome.attempts).toHaveLength(1);
  });

  it('reports blocked when every provider in the role list is exhausted', async () => {
    const ctx = makeTestCtx();
    addMockProfile(ctx, 'coder', scripts.quota());
    addMockProfile(ctx, 'coder', scripts.quota());

    const outcome = await ctx.runner.run(baseReq(ctx));

    expect(outcome.ok).toBe(false);
    expect(outcome.blocked).toBe(true);
    expect(outcome.attempts).toHaveLength(2);
  });

  it('detects a stuck run, invokes onStuck with the log tail, then kills it', async () => {
    const ctx = makeTestCtx();
    addMockProfile(ctx, 'coder', scripts.stall());

    let stuckLogTail = '';
    const outcome = await ctx.runner.run({
      ...baseReq(ctx),
      timeouts: { stuckMs: 300, wallClockMs: 30_000 },
      onStuck: ({ logTail }) => {
        stuckLogTail = logTail;
      },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.finalRun!.status).toBe('stuck');
    expect(stuckLogTail).toContain('system');
  }, 15_000);

  it('kills a run that exceeds the wall clock limit', async () => {
    const ctx = makeTestCtx();
    addMockProfile(ctx, 'coder', scripts.stall());

    const outcome = await ctx.runner.run({
      ...baseReq(ctx),
      timeouts: { stuckMs: 60_000, wallClockMs: 400 },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.finalRun!.status).toBe('killed');
    expect(outcome.finalRun!.resultText).toContain('wall-clock');
    // A watchdog timeout is NOT a user kill — it must burn the retry budget.
    expect(outcome.userKilled).toBe(false);
  }, 15_000);

  it('supports external kill', async () => {
    const ctx = makeTestCtx();
    addMockProfile(ctx, 'coder', scripts.stall());

    const promise = ctx.runner.run(baseReq(ctx));
    await new Promise((r) => setTimeout(r, 400));
    const running = ctx.runStore.listRunning();
    expect(running).toHaveLength(1);
    expect(ctx.runner.kill(running[0]!.id)).toBe(true);

    const outcome = await promise;
    expect(outcome.finalRun!.status).toBe('killed');
    // An external kill IS a user kill — it re-queues for free, no retry burned.
    expect(outcome.userKilled).toBe(true);
  }, 15_000);

  it('marks orphaned running rows as killed on recovery', async () => {
    const ctx = makeTestCtx();
    const profile = addMockProfile(ctx, null, scripts.success());
    ctx.runStore.create({
      role: 'coder',
      providerProfileId: profile.id,
      logPath: path.join(ctx.tmpDir, 'orphan.ndjson'),
      pid: 999999,
    });

    ctx.runner.recoverOrphans();
    expect(ctx.runStore.listRunning()).toHaveLength(0);
  });
});
