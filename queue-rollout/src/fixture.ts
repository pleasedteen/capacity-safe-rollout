/**
 * Service fixture: hosts N local queue-processing services, each on its own
 * port. A service holds its current config, persists it to its own state file
 * (so a service-process restart keeps the config), and answers:
 *
 *   GET  /config                 -> { service, config, capacities, quota }
 *   POST /config {config,switchId} -> validate, persist, ack (idempotent)
 *   POST /admin/flaky {dropNext} -> apply the next N switches but drop the receipt
 *   POST /admin/delay {ms}       -> artificial apply latency
 *   GET  /admin/state            -> fixture internals (for tests)
 *
 * Usage: node fixture.js --config services.json --state-dir DIR
 * services.json: { "services": [{ "name","port","initial","configs":[ConfigSpec...] }] }
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

interface FixtureConfigSpec {
  name: string;
  capacities: Record<string, number>;
  quota: number;
}

interface FixtureService {
  name: string;
  port: number;
  initial: string;
  configs: FixtureConfigSpec[];
}

interface ServiceRuntime {
  def: FixtureService;
  current: string;
  dropNext: number;
  dropGetNext: number;
  delayMs: number;
  stateFile: string;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] ?? '';
    i++;
  }
  return out;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function loadState(rt: ServiceRuntime): void {
  try {
    const j = JSON.parse(fs.readFileSync(rt.stateFile, 'utf8'));
    if (typeof j.config === 'string' && rt.def.configs.some((c) => c.name === j.config)) {
      rt.current = j.config;
    }
  } catch {
    /* no state file yet -> initial */
  }
}

function persistState(rt: ServiceRuntime): void {
  const tmp = rt.stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ config: rt.current }));
  fs.renameSync(tmp, rt.stateFile); // atomic on POSIX
}

function startService(rt: ServiceRuntime): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/config') {
        if (rt.dropGetNext > 0) {
          rt.dropGetNext -= 1;
          console.log(`[fixture:${rt.def.name}] DROPPED a config query (dropGetNext left=${rt.dropGetNext})`);
          res.socket?.destroy();
          return;
        }
        const cfg = rt.def.configs.find((c) => c.name === rt.current)!;
        return send(res, 200, {
          service: rt.def.name,
          config: rt.current,
          capacities: cfg.capacities,
          quota: cfg.quota,
        });
      }
      if (req.method === 'POST' && url.pathname === '/config') {
        const body = await readBody(req);
        const cfg = rt.def.configs.find((c) => c.name === body.config);
        if (!cfg) return send(res, 409, { ok: false, error: `unknown config '${body.config}'` });
        if (rt.delayMs > 0) await new Promise((r) => setTimeout(r, rt.delayMs));
        rt.current = cfg.name;
        persistState(rt); // effective first, receipt second — receipt may be lost
        if (rt.dropNext > 0) {
          rt.dropNext -= 1;
          console.log(`[fixture:${rt.def.name}] applied '${cfg.name}' but DROPPED the receipt (switchId=${body.switchId})`);
          res.socket?.destroy();
          return;
        }
        return send(res, 200, { ok: true, service: rt.def.name, config: rt.current, switchId: body.switchId });
      }
      if (req.method === 'POST' && url.pathname === '/admin/flaky') {
        const body = await readBody(req);
        rt.dropNext = Number(body.dropNext ?? 0);
        rt.dropGetNext = Number(body.dropGetNext ?? 0);
        return send(res, 200, { ok: true, dropNext: rt.dropNext, dropGetNext: rt.dropGetNext });
      }
      if (req.method === 'POST' && url.pathname === '/admin/delay') {
        const body = await readBody(req);
        rt.delayMs = Number(body.ms ?? 0);
        return send(res, 200, { ok: true, delayMs: rt.delayMs });
      }
      if (req.method === 'GET' && url.pathname === '/admin/state') {
        return send(res, 200, { service: rt.def.name, current: rt.current, dropNext: rt.dropNext, delayMs: rt.delayMs });
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 500, { error: String((err as Error)?.message ?? err) });
    }
  });
  server.listen(rt.def.port, () => {
    console.log(`[fixture:${rt.def.name}] on :${rt.def.port}, config=${rt.current}`);
  });
  return server;
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const configFile = args.config;
  const stateDir = args['state-dir'] ?? './fixture-state';
  if (!configFile) {
    console.error('usage: fixture --config services.json --state-dir DIR');
    process.exit(2);
  }
  const def = JSON.parse(fs.readFileSync(configFile, 'utf8')) as { services: FixtureService[] };
  fs.mkdirSync(stateDir, { recursive: true });
  const servers: http.Server[] = [];
  for (const svc of def.services) {
    const rt: ServiceRuntime = {
      def: svc,
      current: svc.initial,
      dropNext: 0,
      dropGetNext: 0,
      delayMs: 0,
      stateFile: path.join(stateDir, `${svc.name}.json`),
    };
    loadState(rt);
    servers.push(startService(rt));
  }
  const shutdown = () => {
    for (const s of servers) s.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) void main();
