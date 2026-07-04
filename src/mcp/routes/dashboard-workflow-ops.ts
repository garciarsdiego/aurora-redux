// Sprint 4.5 / Agent M2-A3: facade re-export of the split workflow-ops router.
//
// The original ~1535 LOC file was split into per-domain modules under
// `./dashboard-workflow-ops/` for maintainability. The public surface
// (`dashboardWorkflowOpsRouter` + `resolveDashboardWorkflowFolderTarget` +
// `DashboardWorkflowFolderTarget`) is preserved here so existing imports —
// notably `http-server.ts` and `tests/unit/dashboard-workflow-open-folder.test.ts` —
// keep working unchanged.

export {
  dashboardWorkflowOpsRouter,
  resolveDashboardWorkflowFolderTarget,
  type DashboardWorkflowFolderTarget,
} from './dashboard-workflow-ops/index.js';
