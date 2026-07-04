// Sprint 4.5 / Agent M2-A3: composition of the split dashboard-workflow-ops
// routers. Each sub-router uses anchored regex (`^...$`), so no two sub-routers
// can match the same path — order below is the original logical order from
// the monolithic dashboard-workflow-ops.ts for readability only.

import type { Router } from '../types.js';
import { runtimeRouter } from './runtime.js';
import { dagsRouter } from './dags.js';
import { lifecycleRouter } from './lifecycle.js';
import { diffRouter } from './diff.js';
import { reviewsRouter } from './reviews.js';
import { tasksRouter } from './tasks.js';

export {
  resolveDashboardWorkflowFolderTarget,
  type DashboardWorkflowFolderTarget,
} from './diff.js';

export const dashboardWorkflowOpsRouter: Router = async (req, url, res, ctx) => {
  if (await runtimeRouter(req, url, res, ctx)) return true;
  if (await dagsRouter(req, url, res, ctx)) return true;
  if (await lifecycleRouter(req, url, res, ctx)) return true;
  if (await diffRouter(req, url, res, ctx)) return true;
  if (await reviewsRouter(req, url, res, ctx)) return true;
  if (await tasksRouter(req, url, res, ctx)) return true;
  return false;
};
