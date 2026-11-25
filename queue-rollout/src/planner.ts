/**
 * Wave planner.
 *
 * A wave is an ordered list of switches; each service appears at most once in a
 * wave, the wave size is bounded, and switches inside a wave take effect one
 * after another, so every prefix of the ordered list must satisfy constraints.
 *
 * planRoute() BFS-searches the state space (one config index per service) for a
 * route from one combination to another within a wave budget. planRollout()
 * additionally verifies that from every actually-effective combination along
 * the rollout route (every prefix of every wave) a rollback route back to the
 * pre-rollout combination exists within the rollback budget.
 */

import {
  Budgets,
  RolloutSpec,
  State,
  checkState,
  describeState,
  formatViolations,
  stateKey,
} from './model.js';

export interface Switch {
  /** service index */
  service: number;
  /** target config index */
  to: number;
}

export interface Wave {
  /** ordered; applied sequentially, each prefix must be constraint-valid */
  switches: Switch[];
}

export interface RouteOk {
  ok: true;
  waves: Wave[];
}

export interface RouteFail {
  ok: false;
  reason: string;
}

export type RouteResult = RouteOk | RouteFail;

const STATE_CAP = 200_000;

function applySwitch(state: State, sw: Switch): State {
  const next = state.slice();
  next[sw.service] = sw.to;
  return next;
}

/**
 * All states reachable from `from` in exactly one wave (1..maxPerWave ordered
 * switches over distinct services, every prefix constraint-valid).
 * Returns a map from state key to the wave that reaches it.
 */
function waveSuccessors(spec: RolloutSpec, from: State, maxPerWave: number): Map<string, { state: State; wave: Wave }> {
  const found = new Map<string, { state: State; wave: Wave }>();
  const n = spec.services.length;

  const dfs = (cur: State, used: boolean[], seq: Switch[]) => {
    if (seq.length > 0) {
      const key = stateKey(cur);
      if (!found.has(key)) found.set(key, { state: cur.slice(), wave: { switches: seq.slice() } });
    }
    if (seq.length >= maxPerWave) return;
    for (let s = 0; s < n; s++) {
      if (used[s]) continue;
      const curCfg = cur[s];
      for (let c = 0; c < spec.services[s].configs.length; c++) {
        if (c === curCfg) continue;
        const next = cur.slice();
        next[s] = c;
        if (checkState(spec, next).length > 0) continue; // every prefix must stay valid
        used[s] = true;
        seq.push({ service: s, to: c });
        dfs(next, used, seq);
        seq.pop();
        used[s] = false;
      }
    }
  };
  dfs(from.slice(), new Array(n).fill(false), []);
  return found;
}

interface BfsResult {
  waves: Wave[] | null;
  visitedCount: number;
  /** all visited states (including start) — used for diagnostics */
  visited: State[];
  capped: boolean;
}

function bfs(spec: RolloutSpec, from: State, to: State, maxWaves: number, maxPerWave: number): BfsResult {
  const targetKey = stateKey(to);
  if (stateKey(from) === targetKey) return { waves: [], visitedCount: 1, visited: [from], capped: false };

  const seen = new Map<string, { state: State; prev: string | null; wave: Wave | null }>();
  seen.set(stateKey(from), { state: from.slice(), prev: null, wave: null });
  let frontier: State[] = [from.slice()];
  let capped = false;

  for (let depth = 1; depth <= maxWaves; depth++) {
    const nextFrontier: State[] = [];
    for (const st of frontier) {
      for (const [key, succ] of waveSuccessors(spec, st, maxPerWave)) {
        if (seen.has(key)) continue;
        seen.set(key, { state: succ.state, prev: stateKey(st), wave: succ.wave });
        if (seen.size > STATE_CAP) {
          capped = true;
          return { waves: null, visitedCount: seen.size, visited: [...seen.values()].map((v) => v.state), capped };
        }
        if (key === targetKey) {
          // reconstruct
          const waves: Wave[] = [];
          let k: string | null = key;
          while (k !== null) {
            const node: { state: State; prev: string | null; wave: Wave | null } | undefined = seen.get(k);
            if (!node) break;
            if (node.wave) waves.unshift(node.wave);
            k = node.prev;
          }
          return { waves, visitedCount: seen.size, visited: [...seen.values()].map((v) => v.state), capped };
        }
        nextFrontier.push(succ.state);
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }
  return { waves: null, visitedCount: seen.size, visited: [...seen.values()].map((v) => v.state), capped };
}

function hamming(a: State, b: State): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** Explain why no route from->to exists within budget. */
function diagnose(spec: RolloutSpec, from: State, to: State, maxWaves: number, maxPerWave: number, first: BfsResult): string {
  // Is it just the wave budget? Retry with a generous wave limit.
  const extended = bfs(spec, from, to, Math.max(maxWaves + 10, 15), maxPerWave);
  if (extended.waves) {
    return `route exists but needs at least ${extended.waves.length} waves (budget allows ${maxWaves})`;
  }
  // Truly blocked: inspect the reachable states closest to the goal.
  const visited = extended.visited.length >= first.visited.length ? extended.visited : first.visited;
  let best: State[] = [];
  let bestD = Infinity;
  for (const st of visited) {
    const d = hamming(st, to);
    if (d < bestD) {
      bestD = d;
      best = [st];
    } else if (d === bestD && best.length < 3) {
      best.push(st);
    }
  }
  const lines: string[] = [];
  for (const st of best) {
    const blockers: string[] = [];
    for (let i = 0; i < to.length; i++) {
      if (st[i] === to[i]) continue;
      const svc = spec.services[i];
      const next = st.slice();
      next[i] = to[i];
      const viol = checkState(spec, next);
      if (viol.length > 0) {
        blockers.push(
          `service ${svc.name} -> '${svc.configs[to[i]].name}' violates: ${formatViolations(viol)}`,
        );
      } else {
        blockers.push(
          `service ${svc.name} -> '${svc.configs[to[i]].name}' is individually valid but every continuation stays blocked`,
        );
      }
    }
    lines.push(`closest reachable combination [${describeState(spec, st)}] (${bestD} service(s) away); blocked by: ${blockers.join(' | ')}`);
  }
  const capNote = extended.capped ? ' (search space cap hit)' : '';
  return `no feasible route within ${maxWaves} waves${capNote}. ${lines.join(' // ')}`;
}

/** Find a route within budget, or explain the blockage. */
export function planRoute(
  spec: RolloutSpec,
  from: State,
  to: State,
  budget: { waves: number; maxPerWave: number },
): RouteResult {
  const first = bfs(spec, from, to, budget.waves, budget.maxPerWave);
  if (first.waves) return { ok: true, waves: first.waves };
  return { ok: false, reason: diagnose(spec, from, to, budget.waves, budget.maxPerWave, first) };
}

export interface RolloutPlanOk {
  ok: true;
  waves: Wave[];
  /** every actually-effective combination along the route (prefixes), verified rollback-able */
  rollbackVerified: boolean;
}

export interface RolloutPlanFail {
  ok: false;
  reason: string;
}

export type RolloutPlanResult = RolloutPlanOk | RolloutPlanFail;

/**
 * Full pre-rollout feasibility check:
 *  1. initial and target combinations must themselves satisfy constraints
 *  2. a rollout route initial -> target must exist within the rollout budget
 *  3. from every actually-effective combination along that route, a rollback
 *     route back to the initial combination must exist within the rollback budget
 */
export function planRollout(spec: RolloutSpec, initial: State, target: State, budgets: Budgets): RolloutPlanResult {
  const initViol = checkState(spec, initial);
  if (initViol.length > 0) {
    return { ok: false, reason: `current combination already violates constraints: ${formatViolations(initViol)}` };
  }
  const tgtViol = checkState(spec, target);
  if (tgtViol.length > 0) {
    return { ok: false, reason: `target combination violates constraints: ${formatViolations(tgtViol)}` };
  }

  const route = planRoute(spec, initial, target, budgets.rollout);
  if (!route.ok) return { ok: false, reason: `rollout infeasible: ${route.reason}` };

  // Enumerate every actually-effective combination along the route.
  const prefixes: State[] = [];
  let cur = initial.slice();
  for (const wave of route.waves) {
    for (const sw of wave.switches) {
      cur = applySwitch(cur, sw);
      prefixes.push(cur.slice());
    }
  }
  for (const st of prefixes) {
    const back = planRoute(spec, st, initial, budgets.rollback);
    if (!back.ok) {
      return {
        ok: false,
        reason:
          `rollback guarantee fails at combination [${describeState(spec, st)}]: ` +
          `cannot return to pre-rollout config within rollback budget (${budgets.rollback.waves} waves x ${budgets.rollback.maxPerWave}/wave). ${back.reason}`,
      };
    }
  }
  return { ok: true, waves: route.waves, rollbackVerified: true };
}
