/**
 * Rollout controller: feasibility check, wave execution, pause/resume/rollback,
 * crash recovery and reconciliation of switches whose receipts were lost.
 *
 * Durability model: every decision is appended to a JSONL journal before (or
 * right after) the corresponding side effect. On boot the journal is replayed,
 * every service is queried for its *actual* config, switches with unknown
 * outcomes are resolved, and an interrupted rollout/rollback is taken over.
 */

import { Journal, JournalEntry } from './journal.js';
import {
  RolloutSpec,
  State,
  checkState,
  configIndex,
  describeState,
  formatViolations,
  validateSpec,
} from './model.js';
import { Switch, Wave, planRollout, planRoute } from './planner.js';

export type Phase =
  | 'ready' // feasible plan computed, not started
  | 'blocked' // infeasible; nothing was or will be dispatched
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'preparing_rollback' // settling in-flight switches + reconciling before rollback
  | 'rolling_back'
  | 'rolled_back'
  | 'error'; // halted unexpectedly; resume after fixing the cause

const TERMINAL: Phase[] = ['blocked', 'succeeded', 'rolled_back'];

export interface UnknownSwitch {
  switchId: string;
  service: string;
  to: string;
  since: number;
}

export interface RolloutRecord {
  id: string;
  spec: RolloutSpec;
  initial: State;
  target: State;
  verified: State; // last verified config index per service
  phase: Phase;
  reason: string | null;
  plan: Wave[] | null;
  planKind: 'rollout' | 'rollback';
  cursor: { wave: number; switch: number };
  rollbackVerified: boolean;
  pauseRequested: boolean;
  rollbackRequested: boolean;
  unknown: UnknownSwitch[];
  dispatchSeq: number; // per-cursor dispatch attempt counter (rebuilt on replay)
  createdAt: number;
}

export interface ControllerOptions {
  dataDir: string;
  /** ms before an unanswered switch is treated as unknown-outcome */
  switchTimeoutMs?: number;
  /** base delay between reconcile attempts */
  reconcileDelayMs?: number;
  /** reconcile attempts before declaring a service unreachable */
  reconcileAttempts?: number;
}

export class Controller {
  private journal: Journal;
  private rollout: RolloutRecord | null = null;
  private loopActive = false;
  private opts: Required<Omit<ControllerOptions, 'dataDir'>>;

  constructor(options: ControllerOptions) {
    this.journal = new Journal(options.dataDir);
    this.opts = {
      switchTimeoutMs: options.switchTimeoutMs ?? 1500,
      reconcileDelayMs: options.reconcileDelayMs ?? 300,
      reconcileAttempts: options.reconcileAttempts ?? 5,
    };
  }

  // ---------------------------------------------------------------- journal

  private emit(type: string, fields: Record<string, unknown> = {}): void {
    this.journal.append({ type, ...fields });
  }

  /** Replay the journal; must be called once at boot, before serving. */
  async recover(): Promise<void> {
    const entries = this.journal.readAll();
    const inflight = new Map<string, { service: string; to: string; since: number }>();
    for (const e of entries) this.apply(e, inflight);
    const r = this.rollout;
    if (!r) return;
    // leftover dispatched-but-never-resolved switches are unknown-outcome
    r.unknown = [...inflight.entries()].map(([switchId, v]) => ({
      switchId,
      service: v.service,
      to: v.to,
      since: v.since,
    }));
    if (TERMINAL.includes(r.phase) || r.phase === 'ready' || r.phase === 'paused') {
      if (r.phase === 'paused' || r.phase === 'ready') {
        // still reconcile so status reflects verified reality, but stay put
        await this.reconcileAll(Math.max(2, this.opts.reconcileAttempts));
      }
      return;
    }
    // take over an interrupted rollout/rollback
    const ok = await this.reconcileAll(this.opts.reconcileAttempts * 4);
    if (!ok) {
      this.setPhase('error', 'a service is unreachable after restart; restore it and call resume');
      return;
    }
    if (r.rollbackRequested || r.phase === 'preparing_rollback') {
      await this.beginRollback();
    }
    if (r.phase === 'running' || r.phase === 'rolling_back') this.kick();
  }

  private apply(e: JournalEntry, inflight: Map<string, { service: string; to: string; since: number }>): void {
    const r = this.rollout;
    switch (e.type) {
      case 'created': {
        const spec = e.spec as RolloutSpec;
        this.rollout = {
          id: e.id as string,
          spec,
          initial: e.initial as State,
          target: e.target as State,
          verified: (e.initial as State).slice(),
          phase: e.feasible ? 'ready' : 'blocked',
          reason: (e.reason as string) ?? null,
          plan: (e.plan as Wave[]) ?? null,
          planKind: 'rollout',
          cursor: { wave: 0, switch: 0 },
          rollbackVerified: Boolean(e.rollbackVerified),
          pauseRequested: false,
          rollbackRequested: false,
          unknown: [],
          dispatchSeq: 0,
          createdAt: e.ts ?? Date.now(),
        };
        inflight.clear();
        break;
      }
      case 'phase':
        if (r) {
          r.phase = e.phase as Phase;
          if (e.reason !== undefined) r.reason = (e.reason as string) ?? null;
        }
        break;
      case 'plan_set':
        if (r) {
          r.plan = e.waves as Wave[];
          r.planKind = e.kind as 'rollout' | 'rollback';
          r.cursor = { wave: 0, switch: 0 };
          r.dispatchSeq = 0;
        }
        break;
      case 'cursor':
        if (r) {
          r.cursor = { wave: e.wave as number, switch: e.switch as number };
          r.dispatchSeq = 0;
        }
        break;
      case 'switch_dispatched':
        if (r) {
          inflight.set(e.switchId as string, {
            service: e.service as string,
            to: e.to as string,
            since: (e.ts as number) ?? Date.now(),
          });
          r.dispatchSeq = (e.seq as number) ?? r.dispatchSeq;
        }
        break;
      case 'switch_acked':
      case 'switch_reconciled': {
        if (r) {
          inflight.delete(e.switchId as string);
          const idx = r.spec.services.findIndex((s) => s.name === e.service);
          const cfgName = (e.config ?? e.actual) as string;
          const ci = configIndex(r.spec.services[idx], cfgName);
          if (idx >= 0 && ci >= 0) r.verified[idx] = ci;
        }
        break;
      }
      case 'switch_confirmed': {
        if (r) {
          const idx = r.spec.services.findIndex((s) => s.name === e.service);
          const ci = idx >= 0 ? configIndex(r.spec.services[idx], e.config as string) : -1;
          if (idx >= 0 && ci >= 0) r.verified[idx] = ci;
        }
        break;
      }
      case 'pause_requested':
        if (r) r.pauseRequested = true;
        break;
      case 'rollback_requested':
        if (r) r.rollbackRequested = true;
        break;
      case 'flags_cleared':
        if (r) {
          if (e.pause) r.pauseRequested = false;
          if (e.rollback) r.rollbackRequested = false;
        }
        break;
    }
  }

  private setPhase(phase: Phase, reason?: string): void {
    const r = this.rollout;
    if (!r) return;
    r.phase = phase;
    if (reason !== undefined) r.reason = reason;
    this.emit('phase', { phase, reason: reason ?? null });
  }

  private persistCursor(): void {
    const r = this.rollout!;
    r.dispatchSeq = 0; // new plan position -> fresh attempt counter
    this.emit('cursor', { wave: r.cursor.wave, switch: r.cursor.switch });
  }

  // ------------------------------------------------------------------- API

  async create(spec: RolloutSpec): Promise<{ id: string; feasible: boolean; reason?: string; plan?: Wave[] }> {
    if (this.rollout && !TERMINAL.includes(this.rollout.phase)) {
      throw new HttpError(409, `rollout ${this.rollout.id} is still active (phase=${this.rollout.phase})`);
    }
    const problems = validateSpec(spec);
    if (problems.length > 0) throw new HttpError(400, `invalid spec: ${problems.join('; ')}`);

    // Snapshot the verified pre-rollout config of every service.
    const initial: State = [];
    for (const svc of spec.services) {
      const cfg = await this.queryServiceConfig(svc.endpoint, svc.name);
      if (cfg == null) throw new HttpError(502, `service ${svc.name} unreachable at ${svc.endpoint}; cannot snapshot current config`);
      const idx = configIndex(svc, cfg);
      if (idx < 0) throw new HttpError(502, `service ${svc.name} reports unknown config '${cfg}' (not in its catalog)`);
      initial.push(idx);
    }
    const target: State = spec.services.map((s) => configIndex(s, s.target));

    const planned = planRollout(spec, initial, target, spec.budgets);
    const id = `r${Date.now().toString(36)}`;
    this.emit('created', {
      id,
      spec,
      initial,
      target,
      feasible: planned.ok,
      reason: planned.ok ? null : planned.reason,
      plan: planned.ok ? planned.waves : null,
      rollbackVerified: planned.ok ? planned.rollbackVerified : false,
    });
    // rebuild in-memory record from the journal entry just written
    this.apply(this.journal.readAll().at(-1)!, new Map());
    const r = this.rollout!;
    r.createdAt = Date.now();
    if (!planned.ok) return { id, feasible: false, reason: planned.reason };
    return { id, feasible: true, plan: planned.waves };
  }

  start(id: string): void {
    const r = this.mustGet(id);
    if (r.phase === 'blocked') throw new HttpError(409, `rollout is blocked: ${r.reason}`);
    if (r.phase !== 'ready') throw new HttpError(409, `cannot start from phase ${r.phase}`);
    this.setPhase('running');
    this.kick();
  }

  pause(id: string): void {
    const r = this.mustGet(id);
    if (r.phase !== 'running' && r.phase !== 'rolling_back') {
      throw new HttpError(409, `cannot pause in phase ${r.phase}`);
    }
    r.pauseRequested = true;
    this.emit('pause_requested', {});
    // the executor finishes the in-flight switch, then pauses
  }

  async resume(id: string): Promise<void> {
    const r = this.mustGet(id);
    if (r.phase !== 'paused' && r.phase !== 'error') {
      throw new HttpError(409, `cannot resume in phase ${r.phase}`);
    }
    const ok = await this.reconcileAll(this.opts.reconcileAttempts);
    if (!ok) {
      throw new HttpError(502, r.reason ?? 'a service is still unreachable; restore it and retry resume');
    }
    if (r.rollbackRequested) {
      await this.beginRollback();
    } else {
      this.setPhase(r.planKind === 'rollback' ? 'rolling_back' : 'running');
    }
    this.kick();
  }

  async rollback(id: string): Promise<void> {
    const r = this.mustGet(id);
    if (r.phase === 'rolling_back' || r.phase === 'preparing_rollback') return; // idempotent
    if (r.phase === 'rolled_back') throw new HttpError(409, 'already rolled back');
    if (r.phase === 'blocked') throw new HttpError(409, 'rollout never started; nothing to roll back');
    r.rollbackRequested = true;
    this.emit('rollback_requested', {});
    if (r.phase === 'running') return; // executor stops dispatching and begins rollback
    if (!this.loopActive) {
      // paused / ready / succeeded / error: settle + reconcile, then roll back
      const ok = await this.reconcileAll(this.opts.reconcileAttempts * 4);
      if (!ok) {
        this.setPhase('error', 'a service is unreachable; rollback budget clock starts once all services are reachable — restore it and call resume');
        return;
      }
      await this.beginRollback();
      this.kick();
    }
  }

  status(id?: string): unknown {
    const r = id ? this.mustGet(id) : this.rollout;
    if (!r) throw new HttpError(404, 'no rollout exists');
    const violations = checkState(r.spec, r.verified);
    return {
      id: r.id,
      phase: r.phase,
      reason: r.reason,
      planKind: r.planKind,
      planWaves: r.plan ? r.plan.length : null,
      cursor: r.cursor,
      rollbackVerified: r.rollbackVerified,
      budgets: r.spec.budgets,
      constraintsOk: violations.length === 0,
      violations: violations.map((v) => v.detail),
      services: r.spec.services.map((s, i) => ({
        name: s.name,
        endpoint: s.endpoint,
        verifiedConfig: s.configs[r.verified[i]].name,
        targetConfig: s.target,
        atTarget: r.verified[i] === r.target[i],
      })),
      unknownSwitches: r.unknown,
      recentEvents: this.journal.readAll().slice(-25),
    };
  }

  activeId(): string | null {
    return this.rollout ? this.rollout.id : null;
  }

  async shutdown(): Promise<void> {
    // wait for the executor to finish its current step, then close the journal
    for (let i = 0; i < 100 && this.loopActive; i++) await sleep(50);
    this.journal.close();
  }

  private mustGet(id: string): RolloutRecord {
    if (!this.rollout || this.rollout.id !== id) throw new HttpError(404, `rollout ${id} not found`);
    return this.rollout;
  }

  // -------------------------------------------------------------- executor

  private kick(): void {
    if (this.loopActive) return;
    this.loopActive = true;
    void this.loop()
      .catch((err) => {
        const r = this.rollout;
        if (r && !TERMINAL.includes(r.phase)) {
          this.setPhase('error', `executor failure: ${String(err?.message ?? err)}`);
        }
      })
      .finally(() => {
        this.loopActive = false;
      });
  }

  private async loop(): Promise<void> {
    for (;;) {
      const r = this.rollout;
      if (!r) return;
      if (r.pauseRequested && (r.phase === 'running' || r.phase === 'rolling_back')) {
        // in-flight switch has already been settled (we are between switches)
        r.pauseRequested = false;
        this.emit('flags_cleared', { pause: true });
        this.setPhase('paused');
        return;
      }
      if (r.rollbackRequested && r.phase === 'running') {
        const ok = await this.beginRollback();
        if (!ok) return; // beginRollback failed -> error
        continue;
      }
      if (r.phase !== 'running' && r.phase !== 'rolling_back') return;
      const step = await this.stepOnce(r);
      if (step === 'plan-complete') {
        this.setPhase(r.planKind === 'rollout' ? 'succeeded' : 'rolled_back');
        return;
      }
      if (step === 'halt') return; // phase already set to error
    }
  }

  private async beginRollback(): Promise<boolean> {
    const r = this.rollout!;
    this.setPhase('preparing_rollback');
    // The rollback budget clock starts only after in-flight switch outcomes are
    // determined and all services are reachable.
    const ok = await this.reconcileAll(this.opts.reconcileAttempts * 4);
    if (!ok) {
      this.setPhase('error', 'cannot prepare rollback: a service is unreachable; restore it and call resume');
      return false;
    }
    const back = planRoute(r.spec, r.verified, r.initial, r.spec.budgets.rollback);
    if (!back.ok) {
      this.setPhase('error', `rollback route not found within budget: ${back.reason}`);
      return false;
    }
    r.plan = back.waves;
    r.planKind = 'rollback';
    r.cursor = { wave: 0, switch: 0 };
    r.rollbackRequested = false;
    this.emit('plan_set', { kind: 'rollback', waves: back.waves });
    this.emit('flags_cleared', { rollback: true });
    this.setPhase('rolling_back');
    return true;
  }

  /**
   * Execute the next switch of the active plan. Returns:
   *  'ok'            - progress made (or skipped), call again
   *  'plan-complete' - all waves done
   *  'halt'          - unrecoverable for now; phase set to error
   */
  private async stepOnce(r: RolloutRecord): Promise<'ok' | 'plan-complete' | 'halt'> {
    const plan = r.plan!;
    if (r.cursor.wave >= plan.length) return 'plan-complete';
    const wave = plan[r.cursor.wave];
    if (r.cursor.switch >= wave.switches.length) {
      this.emit('wave_completed', { kind: r.planKind, wave: r.cursor.wave });
      r.cursor.wave += 1;
      r.cursor.switch = 0;
      this.persistCursor();
      return 'ok';
    }
    const sw: Switch = wave.switches[r.cursor.switch];
    const svc = r.spec.services[sw.service];
    const toName = svc.configs[sw.to].name;

    if (r.verified[sw.service] === sw.to) {
      // already in place (e.g. receipt lost but the switch had taken effect)
      this.emit('switch_confirmed', { service: svc.name, config: toName });
      r.cursor.switch += 1;
      this.persistCursor();
      return 'ok';
    }

    // defense in depth: never dispatch from a constraint-violating verified state
    const viol = checkState(r.spec, r.verified);
    if (viol.length > 0) {
      this.setPhase('error', `verified state violates constraints, refusing to dispatch: ${formatViolations(viol)}`);
      return 'halt';
    }

    r.dispatchSeq += 1;
    const switchId = `${r.id}:${r.planKind}:w${r.cursor.wave}:s${r.cursor.switch}:a${r.dispatchSeq}`;
    this.emit('switch_dispatched', {
      switchId,
      service: svc.name,
      to: toName,
      wave: r.cursor.wave,
      switchIndex: r.cursor.switch,
      kind: r.planKind,
      seq: r.dispatchSeq,
    });

    const acked = await this.dispatchSwitch(svc.endpoint, toName, switchId);
    if (acked) {
      this.emit('switch_acked', { switchId, service: svc.name, config: toName });
      r.verified[sw.service] = sw.to;
      r.cursor.switch += 1;
      this.persistCursor();
      return 'ok';
    }

    // Receipt lost: the switch may or may not have taken effect.
    const unknown: UnknownSwitch = { switchId, service: svc.name, to: toName, since: Date.now() };
    r.unknown.push(unknown);
    this.emit('switch_unknown', { switchId, service: svc.name, to: toName });

    const actual = await this.reconcileService(svc.endpoint, svc.name, this.opts.reconcileAttempts);
    if (actual == null) {
      this.setPhase('error', `service ${svc.name} unreachable while resolving switch ${switchId}; restore it and call resume`);
      return 'halt';
    }
    this.resolveUnknown(r, svc.name, actual);
    const actualIdx = configIndex(svc, actual);
    if (actualIdx === sw.to) {
      r.cursor.switch += 1;
      this.persistCursor();
      return 'ok';
    }
    // switch did not take effect; re-dispatch a bounded number of times
    if (r.dispatchSeq >= 4) {
      this.setPhase('error', `switch to '${toName}' on ${svc.name} did not take effect after ${r.dispatchSeq} attempts`);
      return 'halt';
    }
    return 'ok';
  }

  private resolveUnknown(r: RolloutRecord, serviceName: string, actualConfig: string): void {
    const idx = r.spec.services.findIndex((s) => s.name === serviceName);
    const ci = configIndex(r.spec.services[idx], actualConfig);
    if (ci >= 0) r.verified[idx] = ci;
    const pend = r.unknown.filter((u) => u.service === serviceName);
    for (const u of pend) {
      this.emit('switch_reconciled', { switchId: u.switchId, service: serviceName, actual: actualConfig });
    }
    r.unknown = r.unknown.filter((u) => u.service !== serviceName);
  }

  /** Query every service for its actual config; resolve unknown switches. */
  private async reconcileAll(attempts: number): Promise<boolean> {
    const r = this.rollout;
    if (!r) return true;
    for (const svc of r.spec.services) {
      const actual = await this.reconcileService(svc.endpoint, svc.name, attempts);
      if (actual == null) return false;
      this.resolveUnknown(r, svc.name, actual);
    }
    const viol = checkState(r.spec, r.verified);
    if (viol.length > 0) {
      this.setPhase('error', `reconciled state violates constraints: ${formatViolations(viol)} [${describeState(r.spec, r.verified)}]`);
      return false;
    }
    return true;
  }

  private async reconcileService(endpoint: string, service: string, attempts: number): Promise<string | null> {
    for (let i = 0; i < attempts; i++) {
      const cfg = await this.queryServiceConfig(endpoint, service);
      if (cfg != null) return cfg;
      await sleep(this.opts.reconcileDelayMs);
    }
    return null;
  }

  private async queryServiceConfig(endpoint: string, _service: string): Promise<string | null> {
    try {
      const res = await fetch(`${endpoint}/config`, {
        signal: AbortSignal.timeout(this.opts.switchTimeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { config?: string };
      return body.config ?? null;
    } catch {
      return null;
    }
  }

  /** POST the new config; resolves true only on a positive receipt. */
  private async dispatchSwitch(endpoint: string, config: string, switchId: string): Promise<boolean> {
    try {
      const res = await fetch(`${endpoint}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config, switchId }),
        signal: AbortSignal.timeout(this.opts.switchTimeoutMs),
      });
      if (!res.ok) {
        // deterministic rejection (e.g. unknown config) — not a lost receipt
        const body = await res.text().catch(() => '');
        throw new HttpError(502, `service rejected switch ${switchId}: HTTP ${res.status} ${body}`);
      }
      const body = (await res.json()) as { ok?: boolean; config?: string };
      return body.ok === true && body.config === config;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      return false; // timeout / connection reset => outcome unknown
    }
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
