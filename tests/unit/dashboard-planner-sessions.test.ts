import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  deleteDashboardPlannerSession,
  listDashboardPlannerSessions,
  renameDashboardPlannerSession,
  upsertDashboardPlannerSession,
} from '../../src/mcp/dashboard-planner-sessions.js';

describe('dashboard planner sessions', () => {
  it('persists and reloads planner sessions with messages and DAG', () => {
    const db = initDb(':memory:');
    try {
      const saved = upsertDashboardPlannerSession(db, {
        id: 'ps_1',
        title: 'Planejar relatório técnico',
        workspace: 'internal',
        objective: 'Planejar relatório técnico',
        messages: [
          { id: 'm1', role: 'user', text: 'Monte um DAG para relatório técnico' },
          {
            id: 'm2',
            role: 'assistant',
            text: 'Aqui está um draft executável.',
            dag: {
              tasks: [
                {
                  id: 't0',
                  name: 'Pesquisar contexto',
                  kind: 'llm_call',
                  depends_on: [],
                  acceptance_criteria: 'Retorna JSON válido com findings',
                },
              ],
            },
            taskCount: 1,
          },
        ],
        dag: {
          tasks: [
            {
              id: 't0',
              name: 'Pesquisar contexto',
              kind: 'llm_call',
              depends_on: [],
              acceptance_criteria: 'Retorna JSON válido com findings',
            },
          ],
        },
      });

      expect(saved.session.id).toBe('ps_1');
      expect(saved.session.updatedAt).toBeGreaterThanOrEqual(saved.session.createdAt);

      const listed = listDashboardPlannerSessions(db, { workspace: 'internal' });
      expect(listed).toEqual([
        expect.objectContaining({
          id: 'ps_1',
          workspace: 'internal',
          messages: [
            expect.objectContaining({ id: 'm1', role: 'user' }),
            expect.objectContaining({
              id: 'm2',
              role: 'assistant',
              taskCount: 1,
              dag: expect.objectContaining({
                tasks: [expect.objectContaining({ id: 't0', kind: 'llm_call' })],
              }),
            }),
          ],
          dag: expect.objectContaining({
            tasks: [expect.objectContaining({ id: 't0', name: 'Pesquisar contexto' })],
          }),
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it('orders sessions by freshness and filters by workspace', async () => {
    const db = initDb(':memory:');
    try {
      upsertDashboardPlannerSession(db, {
        id: 'ps_internal',
        title: 'Sessão interna',
        workspace: 'internal',
        objective: 'Sessão interna',
        messages: [{ id: 'a', role: 'user', text: 'interno' }],
        dag: null,
      });

      await new Promise((resolve) => setTimeout(resolve, 5));

      upsertDashboardPlannerSession(db, {
        id: 'ps_client',
        title: 'Sessão cliente',
        workspace: 'clientdemo',
        objective: 'Sessão cliente',
        messages: [{ id: 'b', role: 'user', text: 'cliente' }],
        dag: null,
      });

      const all = listDashboardPlannerSessions(db, {});
      expect(all.map((session) => session.id)).toEqual(['ps_client', 'ps_internal']);

      const internal = listDashboardPlannerSessions(db, { workspace: 'internal' });
      expect(internal.map((session) => session.id)).toEqual(['ps_internal']);
    } finally {
      db.close();
    }
  });

  it('renames and deletes planner sessions', () => {
    const db = initDb(':memory:');
    try {
      upsertDashboardPlannerSession(db, {
        id: 'ps_edit',
        title: 'Nome antigo',
        workspace: 'internal',
        objective: 'Objetivo original',
        messages: [{ id: 'a', role: 'user', text: 'planeje' }],
        dag: null,
      });

      const renamed = renameDashboardPlannerSession(db, 'ps_edit', { title: 'Nome novo' });
      expect(renamed.session.title).toBe('Nome novo');
      expect(renamed.session.objective).toBe('Objetivo original');

      const removed = deleteDashboardPlannerSession(db, 'ps_edit');
      expect(removed).toEqual({ deleted: true, id: 'ps_edit' });
      expect(listDashboardPlannerSessions(db, {}).map((session) => session.id)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
