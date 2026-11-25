/**
 * End-to-end tests: real controller process + real fixture processes.
 *
 *  1. normal rollout reaches target within the wave budget (incl. pause/resume)
 *  2. infeasible spec is blocked with a reason and keeps current config
 *  3. too-small wave budget is reported with the required wave count
 *  4. lost receipt + controller kill + service-process restart -> takeover,
 *     then rollback to the pre-rollout config within the rollback budget
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER_JS = path.join(ROOT, 'dist', 'src', 'server.js');
const FIXTURE_JS = path.join(ROOT, 'dist', 'src', 'fixture.js');

// ---------------------------------------------------------------- fixtures

const CATALOG: Record<string, any[]> = {
  ingest: [
    { name: 'v1', capacities: { orders: 8, payments: 1 }, quota: 4 },
    { name: 'v2t', capacities: { orders: 4, payments: 4 }, quota: 5 },
    { name: 'v2', capacities: { orders: 1, payments: 8 }, quota: 4 },
  ],
  worker: [
    { name: 'v1', capacities: { orders: 1, payments: 8 }, quota: 4 },
    { name: 'v2t', capacities: { orders: 4, payments: 4 }, quota: 5 },
    { name: 'v2', capacities: { orders: 8, payments: 1 }, quota: 4 },
  ],
};

const KINDS = ['ingest', 'ingest', 'worker', 'worker'];
const NAMES = ['ingest-1', 'ingest-2', 'worker-1', 'worker-2'];

function fixtureDef(base: number) {
  return {
    services: NAMES.map((name, i) => ({ name, port: base + i, initial: 'v1', configs: CATALOG[KINDS[i]] })),
  };
}

function rolloutSpec(base: number, opts: { quotaLimit?: number; budgets?: unknown } = {}) {
  return {
    queues: [
      { name: 'orders', minCapacity: 12 },
      { name: 'payments', minCapacity: 12 },
    ],
    quotaLimit: opts.quotaLimit ?? 18,
    services: NAMES.map((name, i) => ({
      name,
      endpoint: `http://127.0.0.1:${base + i}`,
      target: 'v2',
      configs: CATALOG[KINDS[i]],
    })),
    budgets: opts.budgets ?? { rollout: { waves: 3, maxPerWave: 2 }, rollback: { waves: 4, maxPerWave: 2 } },
  };
}

// ------------------------------------------------------------------ helpers

const running: ChildProcess[] = [];

function startProc(tag: string, script: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  const p = spawn('node', [script, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout!.on('data', (d) => process.stdout.write(`    [${tag}] ${String(d).trimEnd()}\n`));
  p.stderr!.on('data', (d) => process.stdout.write(`    [${tag}!] ${String(d).trimEnd()}\n`));
  running.push(p);
  return p;
}

async function killProc(p: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    if (p.exitCode !== null || p.signalCode) return resolve();
    p.once('exit', () => resolve());
    p.kill('SIGKILL');
    setTimeout(resolve, 3000).unref();
  });
}

async function stopAll(): Promise<void> {
  await Promise.all(running.splice(0).map(killProc));
}

async function waitFor<T>(fn: () => Promise<T | null | false>, desc: string, timeout = 20000, interval = 60): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for: ${desc}${lastErr ? ` (last error: ${lastErr})` : ''}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function api(port: number, method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function serviceConfig(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/config`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
    return ((await res.json()) as any).config ?? null;
  } catch {
    return null;
  }
}

async function waitFixture(base: number): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await waitFor(async () => (await serviceConfig(base + i)) != null, `fixture service ${NAMES[i]} up`);
  }
}

interface Env {
  dir: string;
  ctrl: ChildProcess;
  fx: ChildProcess;
  ctrlPort: number;
  base: number;
}

async function setup(base: number, ctrlPort: number, ctrlEnv: Record<string, string> = {}): Promise<Env> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-rollout-test-'));
  const fixtureFile = path.join(dir, 'services.json');
  fs.writeFileSync(fixtureFile, JSON.stringify(fixtureDef(base)));
  const fx = startProc(`fixture:${base}`, FIXTURE_JS, ['--config', fixtureFile, '--state-dir', path.join(dir, 'fx')]);
  const ctrl = startProc(
    `ctrl:${ctrlPort}`,
    SERVER_JS,
    ['--port', String(ctrlPort), '--data-dir', path.join(dir, 'ctrl')],
    { SWITCH_TIMEOUT_MS: '800', RECONCILE_DELAY_MS: '150', ...ctrlEnv },
  );
  await waitFor(async () => (await api(ctrlPort, 'GET', '/health')).status === 200, 'controller healthy');
  await waitFixture(base);
  return { dir, ctrl, fx, ctrlPort, base };
}

async function statusOf(ctrlPort: number, id: string): Promise<any> {
  return (await api(ctrlPort, 'GET', `/rollouts/${id}`)).body;
}

// ------------------------------------------------------------------- tests

test('1. normal rollout reaches target within wave budget (with pause/resume)', async (t) => {
  t.after(stopAll);
  const base = 7410;
  const { ctrlPort } = await setup(base, 8401);

  const created = await api(ctrlPort, 'POST', '/rollouts', rolloutSpec(base));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.feasible, true, `expected feasible, got ${JSON.stringify(created.body)}`);
  const plan = created.body.plan as { switches: { service: number; to: number }[] }[];
  t.diagnostic(`plan: ${plan.length} wave(s): ${plan.map((w) => `[${w.switches.map((s) => `${NAMES[s.service]}->cfg${s.to}`).join(', ')}]`).join(' ')}`);
  assert.ok(plan.length <= 3, `plan uses ${plan.length} waves <= budget 3`);
  for (const w of plan) {
    assert.ok(w.switches.length <= 2, 'wave size within per-wave budget');
    assert.equal(new Set(w.switches.map((s) => s.service)).size, w.switches.length, 'each service at most once per wave');
  }
  const id = created.body.id;

  await api(ctrlPort, 'POST', `/rollouts/${id}/start`);
  await api(ctrlPort, 'POST', `/rollouts/${id}/pause`);
  const paused = await waitFor(async () => {
    const s = await statusOf(ctrlPort, id);
    return s.phase === 'paused' ? s : null;
  }, 'phase=paused');
  assert.equal(paused.unknownSwitches.length, 0, 'in-flight switches settled when paused');
  const cursorAtPause = JSON.stringify(paused.cursor);
  await new Promise((r) => setTimeout(r, 400));
  const still = await statusOf(ctrlPort, id);
  assert.equal(JSON.stringify(still.cursor), cursorAtPause, 'no new switches dispatched while paused');
  assert.equal(still.constraintsOk, true, 'constraints hold at pause point');
  t.diagnostic(`paused at wave ${paused.cursor.wave}; resuming`);

  await api(ctrlPort, 'POST', `/rollouts/${id}/resume`);
  const done = await waitFor(async () => {
    const s = await statusOf(ctrlPort, id);
    return ['succeeded', 'error'].includes(s.phase) ? s : null;
  }, 'rollout finished');
  assert.equal(done.phase, 'succeeded', `expected succeeded, got ${done.phase}: ${done.reason ?? ''}`);
  assert.ok(done.cursor.wave <= 3, `finished in ${done.cursor.wave} waves <= budget 3`);
  assert.equal(done.constraintsOk, true);
  for (let i = 0; i < 4; i++) {
    assert.equal(await serviceConfig(base + i), 'v2', `${NAMES[i]} at target config`);
  }
  t.diagnostic('all services at target config v2 within wave budget');
});

test('2. infeasible spec is blocked with a reason and keeps current config', async (t) => {
  t.after(stopAll);
  const base = 7420;
  const { ctrlPort } = await setup(base, 8402);

  const created = await api(ctrlPort, 'POST', '/rollouts', rolloutSpec(base, { quotaLimit: 16 }));
  assert.equal(created.body.feasible, false);
  t.diagnostic(`blocked reason: ${created.body.reason}`);
  assert.match(created.body.reason, /no feasible route|violates/);

  const start = await api(ctrlPort, 'POST', `/rollouts/${created.body.id}/start`);
  assert.equal(start.status, 409, 'blocked rollout must not start');
  const st = await statusOf(ctrlPort, created.body.id);
  assert.equal(st.phase, 'blocked');
  for (let i = 0; i < 4; i++) {
    assert.equal(await serviceConfig(base + i), 'v1', `${NAMES[i]} kept current config`);
  }
  t.diagnostic('current config kept; nothing dispatched');
});

test('3. too-small wave budget is reported with the required wave count', async (t) => {
  t.after(stopAll);
  const base = 7430;
  const { ctrlPort } = await setup(base, 8403);

  const spec = rolloutSpec(base, { budgets: { rollout: { waves: 2, maxPerWave: 2 }, rollback: { waves: 4, maxPerWave: 2 } } });
  const created = await api(ctrlPort, 'POST', '/rollouts', spec);
  assert.equal(created.body.feasible, false);
  t.diagnostic(`blocked reason: ${created.body.reason}`);
  assert.match(created.body.reason, /needs at least 3 waves/);
});

test('4. lost receipt + controller kill + service restart -> takeover, then rollback', async (t) => {
  t.after(stopAll);
  const base = 7440;
  const ctrlPort = 8404;
  // slow reconcile loop widens the unknown-outcome window so the kill is deterministic
  const env = await setup(base, ctrlPort, { RECONCILE_DELAY_MS: '1000' });

  const created = await api(ctrlPort, 'POST', '/rollouts', rolloutSpec(base));
  assert.equal(created.body.feasible, true, JSON.stringify(created.body));
  const id = created.body.id as string;
  const plan = created.body.plan as { switches: { service: number; to: number }[] }[];

  // the second switch executed overall will lose its receipt
  const ordered = plan.flatMap((w) => w.switches);
  const victim = ordered[1];
  const victimName = NAMES[victim.service];
  const victimPort = base + victim.service;
  const victimTarget = CATALOG[KINDS[victim.service]][victim.to].name;
  await api(victimPort, 'POST', '/admin/flaky', { dropNext: 1, dropGetNext: 3 });
  t.diagnostic(`service ${victimName} will apply switch #2 (-> ${victimTarget}) but drop the receipt`);

  await api(ctrlPort, 'POST', `/rollouts/${id}/start`);
  await waitFor(async () => {
    const s = await statusOf(ctrlPort, id);
    return s.unknownSwitches.length > 0 ? s : null;
  }, 'unknown-outcome switch recorded');
  const journalRaw = fs.readFileSync(path.join(env.dir, 'ctrl', 'journal.jsonl'), 'utf8');
  assert.match(journalRaw, /"switch_unknown"/, 'unknown switch persisted in journal');
  t.diagnostic('switch outcome unknown; killing controller (SIGKILL) and the service process');

  await killProc(env.ctrl);
  await killProc(env.fx);

  // service process restarts; its config survives because it is persisted per-service
  const fx2 = startProc(`fixture:${base}#2`, FIXTURE_JS, ['--config', path.join(env.dir, 'services.json'), '--state-dir', path.join(env.dir, 'fx')]);
  env.fx = fx2;
  await waitFixture(base);
  assert.equal(await serviceConfig(victimPort), victimTarget, 'service kept the applied config across its own restart');

  // controller restarts on the same data dir and takes over the same rollout
  const ctrl2 = startProc(
    `ctrl:${ctrlPort}#2`,
    SERVER_JS,
    ['--port', String(ctrlPort), '--data-dir', path.join(env.dir, 'ctrl')],
    { SWITCH_TIMEOUT_MS: '800', RECONCILE_DELAY_MS: '150' },
  );
  env.ctrl = ctrl2;
  await waitFor(async () => (await api(ctrlPort, 'GET', '/health')).status === 200, 'controller restarted');

  const taken = await statusOf(ctrlPort, id);
  assert.equal(taken.unknownSwitches.length, 0, 'unknown switch resolved after takeover');
  const reconciled = (taken.recentEvents as any[]).filter((e) => e.type === 'switch_reconciled' && e.service === victimName);
  assert.ok(reconciled.length > 0, `reconciliation of ${victimName} recorded in journal`);
  t.diagnostic(`takeover ok: ${victimName} verified at ${victimTarget} via reconcile`);

  const done = await waitFor(async () => {
    const s = await statusOf(ctrlPort, id);
    return ['succeeded', 'error'].includes(s.phase) ? s : null;
  }, 'rollout completes after takeover');
  assert.equal(done.phase, 'succeeded', `expected succeeded, got ${done.phase}: ${done.reason ?? ''}`);
  for (let i = 0; i < 4; i++) assert.equal(await serviceConfig(base + i), 'v2', `${NAMES[i]} at target`);
  t.diagnostic('rollout reached target after takeover');

  // rollback to the pre-rollout config within the rollback budget
  await api(ctrlPort, 'POST', `/rollouts/${id}/rollback`);
  const back = await waitFor(async () => {
    const s = await statusOf(ctrlPort, id);
    return ['rolled_back', 'error'].includes(s.phase) ? s : null;
  }, 'rollback completes');
  assert.equal(back.phase, 'rolled_back', `expected rolled_back, got ${back.phase}: ${back.reason ?? ''}`);
  assert.ok(back.planWaves <= 4, `rollback used ${back.planWaves} waves <= budget 4`);
  for (let i = 0; i < 4; i++) assert.equal(await serviceConfig(base + i), 'v1', `${NAMES[i]} back to pre-rollout config`);
  t.diagnostic(`rolled back to pre-rollout config in ${back.planWaves} wave(s) within budget`);
});
