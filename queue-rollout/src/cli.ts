/**
 * Ops CLI: talks to a running controller.
 *
 *   node cli.js create <spec.json>     create rollout + feasibility check
 *   node cli.js start|pause|resume|rollback [id]
 *   node cli.js status [id]            verified configs, unknown switches, progress
 *   node cli.js watch [id]             poll status until a terminal phase
 *
 * Controller address: --controller http://127.0.0.1:8300 or env CONTROLLER.
 */

const BASE = process.env.CONTROLLER ?? arg('--controller') ?? 'http://127.0.0.1:8300';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(json as any).error ?? res.statusText}`);
  return json;
}

function renderStatus(s: any): string {
  const lines: string[] = [];
  lines.push(`rollout ${s.id}  phase=${s.phase}${s.reason ? `  reason=${s.reason}` : ''}`);
  if (s.planWaves != null) {
    lines.push(`  plan: ${s.planKind}, ${s.planWaves} wave(s), cursor at wave ${s.cursor.wave} switch ${s.cursor.switch}`);
  }
  lines.push(`  constraints ok: ${s.constraintsOk}${s.violations?.length ? '  VIOLATIONS: ' + s.violations.join('; ') : ''}`);
  for (const svc of s.services ?? []) {
    lines.push(
      `  ${svc.atTarget ? '✓' : ' '} ${svc.name.padEnd(12)} verified=${svc.verifiedConfig.padEnd(8)} target=${svc.targetConfig}`,
    );
  }
  if (s.unknownSwitches?.length) {
    lines.push(`  UNKNOWN-OUTCOME SWITCHES (receipt lost, being resolved):`);
    for (const u of s.unknownSwitches) {
      lines.push(`    ? ${u.service} -> ${u.to}  (${u.switchId})`);
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  const positional = rest.filter((a) => !a.startsWith('--'));
  switch (cmd) {
    case 'create': {
      const fs = await import('node:fs');
      const spec = JSON.parse(fs.readFileSync(positional[0], 'utf8'));
      const out = await api('POST', '/rollouts', spec);
      if (out.feasible) {
        console.log(`created rollout ${out.id}: FEASIBLE (rollback to current config verified within rollback budget)`);
        out.plan.forEach((w: any, i: number) => {
          const steps = w.switches.map(
            (sw: any) => `${spec.services[sw.service].name} -> ${spec.services[sw.service].configs[sw.to].name}`,
          );
          console.log(`  wave ${i + 1}: ${steps.join(',  ')}`);
        });
      } else {
        console.log(`created rollout ${out.id}: INFEASIBLE — ${out.reason}`);
        console.log('current config kept; nothing will be dispatched.');
      }
      break;
    }
    case 'start':
    case 'pause':
    case 'resume':
    case 'rollback': {
      const id = positional[0] ?? (await api('GET', '/status')).id;
      const s = await api('POST', `/rollouts/${id}/${cmd}`);
      console.log(renderStatus(s));
      break;
    }
    case 'status': {
      const id = positional[0];
      const s = await api('GET', id ? `/rollouts/${id}` : '/status');
      console.log(renderStatus(s));
      break;
    }
    case 'watch': {
      const id = positional[0] ?? (await api('GET', '/status')).id;
      for (;;) {
        const s = await api('GET', `/rollouts/${id}`);
        console.log(renderStatus(s));
        if (['succeeded', 'rolled_back', 'blocked', 'error'].includes(s.phase)) break;
        await new Promise((r) => setTimeout(r, 500));
        console.log('---');
      }
      break;
    }
    default:
      console.log('usage: cli create <spec.json> | start|pause|resume|rollback [id] | status [id] | watch [id]');
      process.exitCode = 2;
  }
}

void main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
