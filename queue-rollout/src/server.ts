/**
 * Controller HTTP API.
 *
 *   GET  /health
 *   POST /rollouts                 create + feasibility check (body: RolloutSpec)
 *   GET  /rollouts/:id             status: verified configs, unknown switches, progress
 *   POST /rollouts/:id/start
 *   POST /rollouts/:id/pause
 *   POST /rollouts/:id/resume
 *   POST /rollouts/:id/rollback
 *   GET  /status                   status of the current rollout
 */

import http from 'node:http';
import { Controller, HttpError } from './controller.js';
import { RolloutSpec } from './model.js';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] ?? '';
    i++;
  }
  return out;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(data);
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port ?? process.env.PORT ?? 8300);
  const dataDir = args['data-dir'] ?? process.env.DATA_DIR ?? './data';
  const controller = new Controller({
    dataDir,
    switchTimeoutMs: Number(process.env.SWITCH_TIMEOUT_MS ?? 1500),
    reconcileDelayMs: Number(process.env.RECONCILE_DELAY_MS ?? 300),
    reconcileAttempts: Number(process.env.RECONCILE_ATTEMPTS ?? 5),
  });
  await controller.recover();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, activeRollout: controller.activeId() });
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        return send(res, 200, controller.status());
      }
      if (parts[0] === 'rollouts') {
        if (req.method === 'POST' && parts.length === 1) {
          const spec = (await readBody(req)) as RolloutSpec;
          return send(res, 200, await controller.create(spec));
        }
        const id = parts[1];
        const action = parts[2];
        if (req.method === 'GET' && parts.length === 2) return send(res, 200, controller.status(id));
        if (req.method === 'POST' && parts.length === 3) {
          switch (action) {
            case 'start':
              controller.start(id);
              break;
            case 'pause':
              controller.pause(id);
              break;
            case 'resume':
              await controller.resume(id);
              break;
            case 'rollback':
              await controller.rollback(id);
              break;
            default:
              throw new HttpError(404, `unknown action ${action}`);
          }
          return send(res, 200, controller.status(id));
        }
      }
      throw new HttpError(404, `no route ${req.method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      return send(res, 500, { error: String((err as Error)?.message ?? err) });
    }
  });

  const shutdown = () => {
    server.close();
    void controller.shutdown().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(port, () => {
    console.log(`[controller] listening on :${port}, data dir: ${dataDir}`);
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) void main();
