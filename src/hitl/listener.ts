import * as http from 'node:http';
import type Database from 'better-sqlite3';
import { resolveHitlGate } from '../db/persist.js';

function getGateStatus(db: Database.Database, gateId: string): string | null {
  const row = db
    .prepare('SELECT status FROM hitl_gates WHERE id = ?')
    .get(gateId) as { status: string } | undefined;
  return row?.status ?? null;
}

function handleResolve(
  db: Database.Database,
  gateId: string,
  decision: string,
  res: http.ServerResponse,
): void {
  if (!gateId || !['approved', 'rejected'].includes(decision)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'gate_id and decision (approved|rejected) required' }));
    return;
  }

  const status = getGateStatus(db, gateId);
  if (!status) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'gate_id not found' }));
    return;
  }
  if (status !== 'pending') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `gate already resolved: ${status}` }));
    return;
  }

  resolveHitlGate(db, gateId, decision as 'approved' | 'rejected');

  const label = decision === 'approved' ? '✓ Aprovado' : '✗ Rejeitado';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:2rem">` +
    `<h2>${label}</h2>` +
    `<p>Gate <code>${gateId}</code> resolvido. Pode fechar esta janela.</p>` +
    `</body></html>`,
  );
}

export function startHitlListener(db: Database.Database, port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);

      if (url.pathname !== '/hitl/respond') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      if (req.method === 'GET') {
        handleResolve(
          db,
          url.searchParams.get('gate_id') ?? '',
          url.searchParams.get('decision') ?? '',
          res,
        );
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { gate_id?: string; decision?: string };
            handleResolve(db, parsed.gate_id ?? '', parsed.decision ?? '', res);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid JSON body' }));
          }
        });
        return;
      }

      res.writeHead(405);
      res.end('Method Not Allowed');
    });

    server.once('error', reject);
    // Bind 127.0.0.1 explicitly — default would bind 0.0.0.0 and expose
    // /hitl/respond to LAN. Slack ngrok flow still works (curl from anywhere
    // tunnels through ngrok which terminates at localhost).
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export function stopHitlListener(server: http.Server): void {
  server.close();
}
