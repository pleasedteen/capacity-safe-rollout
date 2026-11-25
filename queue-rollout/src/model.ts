/**
 * Domain model: queues, service configs, capacity/quota constraints.
 *
 * Each service carries a catalog of allowed configs. A config decides how much
 * processing capacity the service provides to each queue, and how much of the
 * shared quota it occupies. At every actually-effective combination of configs
 * (including every intermediate state inside a wave) the system must satisfy:
 *   - for each queue: sum of provided capacities >= queue minimum
 *   - sum of occupied quota <= quota limit
 */

export interface QueueReq {
  name: string;
  minCapacity: number;
}

export interface ConfigSpec {
  name: string;
  /** capacity provided to each queue, keyed by queue name */
  capacities: Record<string, number>;
  /** shared quota occupied while this config is effective */
  quota: number;
}

export interface ServiceSpec {
  name: string;
  /** base URL of the service fixture, e.g. http://127.0.0.1:7101 */
  endpoint: string;
  /** catalog of allowed configs: current, target and approved transitional ones */
  configs: ConfigSpec[];
  /** name of the target config for this rollout */
  target: string;
}

export interface WaveBudget {
  /** max number of waves */
  waves: number;
  /** max services switched per wave (each service at most once per wave) */
  maxPerWave: number;
}

export interface Budgets {
  rollout: WaveBudget;
  rollback: WaveBudget;
}

export interface RolloutSpec {
  queues: QueueReq[];
  quotaLimit: number;
  services: ServiceSpec[];
  budgets: Budgets;
}

/** A state is one config index per service (index into ServiceSpec.configs). */
export type State = number[];

export interface Violation {
  kind: 'capacity' | 'quota';
  detail: string;
}

export function stateKey(s: State): string {
  return s.join(',');
}

export function configIndex(svc: ServiceSpec, name: string): number {
  return svc.configs.findIndex((c) => c.name === name);
}

/** Validate a state against all queue minimums and the quota limit. */
export function checkState(spec: RolloutSpec, state: State): Violation[] {
  const out: Violation[] = [];
  for (const q of spec.queues) {
    let have = 0;
    for (let i = 0; i < spec.services.length; i++) {
      const cfg = spec.services[i].configs[state[i]];
      have += cfg.capacities[q.name] ?? 0;
    }
    if (have < q.minCapacity) {
      out.push({
        kind: 'capacity',
        detail: `queue '${q.name}' capacity ${have} < minimum ${q.minCapacity}`,
      });
    }
  }
  let quota = 0;
  for (let i = 0; i < spec.services.length; i++) {
    quota += spec.services[i].configs[state[i]].quota;
  }
  if (quota > spec.quotaLimit) {
    out.push({
      kind: 'quota',
      detail: `quota ${quota} > limit ${spec.quotaLimit}`,
    });
  }
  return out;
}

export function formatViolations(v: Violation[]): string {
  return v.map((x) => x.detail).join('; ');
}

/** Human-readable description of a state, e.g. "svc-a=v2, svc-b=v1". */
export function describeState(spec: RolloutSpec, state: State): string {
  return spec.services.map((s, i) => `${s.name}=${s.configs[state[i]].name}`).join(', ');
}

/** Structural validation of a rollout spec; returns list of problems. */
export function validateSpec(spec: RolloutSpec): string[] {
  const problems: string[] = [];
  if (!spec.queues?.length) problems.push('at least one queue is required');
  if (!(spec.quotaLimit > 0)) problems.push('quotaLimit must be positive');
  if (!spec.services?.length) problems.push('at least one service is required');
  const qnames = new Set((spec.queues ?? []).map((q) => q.name));
  for (const svc of spec.services ?? []) {
    if (!svc.name) problems.push('service with empty name');
    if (!svc.endpoint) problems.push(`service ${svc.name}: endpoint required`);
    if (!svc.configs?.length) problems.push(`service ${svc.name}: needs at least one config`);
    const seen = new Set<string>();
    for (const c of svc.configs ?? []) {
      if (seen.has(c.name)) problems.push(`service ${svc.name}: duplicate config '${c.name}'`);
      seen.add(c.name);
      for (const q of qnames) {
        if (typeof c.capacities?.[q] !== 'number') {
          problems.push(`service ${svc.name} config '${c.name}': missing capacity for queue '${q}'`);
        }
      }
      if (typeof c.quota !== 'number') {
        problems.push(`service ${svc.name} config '${c.name}': missing quota`);
      }
    }
    if (configIndex(svc, svc.target) < 0) {
      problems.push(`service ${svc.name}: target config '${svc.target}' not in catalog`);
    }
  }
  for (const [label, b] of [['rollout', spec.budgets?.rollout], ['rollback', spec.budgets?.rollback]] as const) {
    if (!b || !(b.waves >= 1) || !(b.maxPerWave >= 1)) {
      problems.push(`budgets.${label}: waves>=1 and maxPerWave>=1 required`);
    }
  }
  return problems;
}
