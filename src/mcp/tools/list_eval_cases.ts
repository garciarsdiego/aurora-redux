import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { listEvalCases, ListEvalCasesSchema } from '../../v2/evals/harness.js';

export { ListEvalCasesSchema };

export async function listEvalCasesTool(raw: unknown): Promise<string> {
  const input = ListEvalCasesSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    return JSON.stringify(listEvalCases(db, input));
  } finally {
    db.close();
  }
}
