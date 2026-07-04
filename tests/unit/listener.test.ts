import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { initDb } from '../../src/db/client.js';
import { insertHitlGate, newHitlGateId } from '../../src/db/persist.js';
import { startHitlListener, stopHitlListener } from '../../src/hitl/listener.js';

const PORT = 13742;

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify(body),
  });
}

async function get(path: string): Promise<Response> {
  return fetch(`http://localhost:${PORT}${path}`, { headers: { Connection: 'close' } });
}

describe('HITL listener', () => {
  let server: http.Server;
  let db: ReturnType<typeof initDb>;
  let gateId: string;

  beforeEach(async () => {
    db = initDb(':memory:');
    db.pragma('foreign_keys = OFF');
    gateId = newHitlGateId();
    insertHitlGate(db, {
      id: gateId,
      workflow_id: 'wf_test',
      gate_type: 'cli',
      prompt: 'Test Gate',
      channel: 'slack',
    });
    server = await startHitlListener(db, PORT);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close(() => resolve());
    });
  });

  it('POST /hitl/respond approved → 200, gate status = approved', async () => {
    const res = await post('/hitl/respond', { gate_id: gateId, decision: 'approved' });
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT status FROM hitl_gates WHERE id = ?').get(gateId) as { status: string };
    expect(row.status).toBe('approved');
  });

  it('POST /hitl/respond rejected → 200, gate status = rejected', async () => {
    const res = await post('/hitl/respond', { gate_id: gateId, decision: 'rejected' });
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT status FROM hitl_gates WHERE id = ?').get(gateId) as { status: string };
    expect(row.status).toBe('rejected');
  });

  it('GET /hitl/respond?gate_id=...&decision=approved → 200, gate resolved', async () => {
    const res = await get(`/hitl/respond?gate_id=${gateId}&decision=approved`);
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT status FROM hitl_gates WHERE id = ?').get(gateId) as { status: string };
    expect(row.status).toBe('approved');
  });

  it('GET /hitl/respond?gate_id=...&decision=rejected → 200, gate resolved', async () => {
    const res = await get(`/hitl/respond?gate_id=${gateId}&decision=rejected`);
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT status FROM hitl_gates WHERE id = ?').get(gateId) as { status: string };
    expect(row.status).toBe('rejected');
  });

  it('POST with unknown gate_id → 400', async () => {
    const res = await post('/hitl/respond', { gate_id: 'hg_nonexistent', decision: 'approved' });
    expect(res.status).toBe(400);
  });

  it('POST with already-resolved gate → 400', async () => {
    await post('/hitl/respond', { gate_id: gateId, decision: 'approved' });
    const res = await post('/hitl/respond', { gate_id: gateId, decision: 'rejected' });
    expect(res.status).toBe(400);
  });

  it('POST with invalid decision → 400', async () => {
    const res = await post('/hitl/respond', { gate_id: gateId, decision: 'maybe' });
    expect(res.status).toBe(400);
  });

  it('POST with invalid JSON body → 400', async () => {
    const res = await fetch(`http://localhost:${PORT}/hitl/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json{{{',
    });
    expect(res.status).toBe(400);
  });

  it('unknown route → 404', async () => {
    const res = await get('/other');
    expect(res.status).toBe(404);
  });

  it('response HTML contains gate_id and decision label', async () => {
    const res = await post('/hitl/respond', { gate_id: gateId, decision: 'approved' });
    const html = await res.text();
    expect(html).toContain(gateId);
    expect(html).toContain('Aprovado');
  });
});
