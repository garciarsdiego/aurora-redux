import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { registerEvalCase, RegisterEvalCaseSchema } from '../../v2/evals/harness.js';

export { RegisterEvalCaseSchema };

export async function registerEvalCaseTool(raw: unknown): Promise<string> {
  const input = RegisterEvalCaseSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    const testCase = registerEvalCase(db, input);
    return JSON.stringify(testCase);
  } finally {
    db.close();
  }
}
