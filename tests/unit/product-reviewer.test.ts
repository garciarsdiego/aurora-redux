import { describe, expect, it } from 'vitest';

import {
  objectiveVsVisibleSurface,
  reviewFinalProductEvidenceBundle,
} from '../../src/quality/product-reviewer.js';
import type { FinalProductEvidenceBundle } from '../../src/quality/types.js';

function bundleWithIssue(): FinalProductEvidenceBundle {
  return {
    workflow: {
      id: 'wf_product_review',
      workspace: 'internal',
      objective: 'Improve existing app',
      status: 'completed',
      metadata: {},
    },
    tasks: [],
    taskQualityReviews: [],
    productHarness: {
      status: 'failed',
      harness: 'static_web_contract',
      checkedRoots: ['C:/project'],
      inspectedFiles: ['C:/project/src/sidecar.tsx'],
      issues: [
        {
          severity: 'blocking',
          code: 'sidecar_dom_island',
          message: 'Sidecar root detected.',
          suggestedAction: 'Integrate into the existing app shell.',
          safeContext: { file: 'src/sidecar.tsx' },
        },
      ],
      notes: [],
      extractedSurfaceText: '',
    },
    structuredErrors: [],
    historicalErrors: [],
    terminalTail: [],
  };
}

interface SurfaceBundleOverrides {
  objective?: string;
  surfaceText?: string;
  inspectedFiles?: string[];
}

function bundleForSurfaceCheck(overrides: SurfaceBundleOverrides = {}): FinalProductEvidenceBundle {
  return {
    workflow: {
      id: 'wf_objective_surface',
      workspace: 'internal',
      objective: overrides.objective ?? '',
      status: 'completed',
      metadata: {},
    },
    tasks: [],
    taskQualityReviews: [],
    productHarness: {
      status: 'passed',
      harness: 'static_web_contract',
      checkedRoots: ['C:/project'],
      inspectedFiles: overrides.inspectedFiles ?? ['C:/project/src/dashboard.tsx'],
      issues: [],
      notes: [],
      extractedSurfaceText: overrides.surfaceText ?? '',
    },
    structuredErrors: [],
    historicalErrors: [],
    terminalTail: [],
  };
}

describe('product reviewer', () => {
  it('blocks product acceptance and drafts fix tasks for architecture-breaking product evidence', () => {
    const result = reviewFinalProductEvidenceBundle(bundleWithIssue());

    expect(result.outcome).toBe('blocked');
    expect(result.score).toBeLessThan(1);
    expect(result.issues.map((issue) => issue.code)).toContain('sidecar_dom_island');
    expect(result.fixTasks[0]?.objective).toContain('Sidecar root detected');
  });
});

describe('objectiveVsVisibleSurface', () => {
  it('warns when the objective mentions features absent from the visible surface text', () => {
    const bundle = bundleForSurfaceCheck({
      objective: 'Add export feature button on the dashboard',
      surfaceText: 'Dashboard\nSettings\nLogout',
    });

    const issues = objectiveVsVisibleSurface(bundle.workflow.objective, bundle);

    expect(issues).toHaveLength(1);
    const [issue] = issues;
    expect(issue.severity).toBe('warning');
    expect(issue.code).toBe('product.objective_visible_mismatch');
    expect(issue.origin).toBe('product_reviewer:objective_visible_surface');
    const missingClaims = issue.safeContext?.missingClaims as string[];
    expect(missingClaims).toContain('export');
    expect(missingClaims).toContain('button');
    expect(missingClaims).toContain('feature');
    expect(missingClaims).not.toContain('dashboard');
  });

  it('does not warn when every objective claim appears in the visible surface text', () => {
    const bundle = bundleForSurfaceCheck({
      objective: 'Add export feature button on the dashboard',
      surfaceText: 'Dashboard\nExport\nFeature\nButton',
    });

    const issues = objectiveVsVisibleSurface(bundle.workflow.objective, bundle);

    expect(issues).toEqual([]);
  });

  it('does not warn when only one claim is missing (threshold requires at least two)', () => {
    const bundle = bundleForSurfaceCheck({
      objective: 'Add export feature button on the dashboard',
      surfaceText: 'Dashboard\nExport\nFeature',
    });

    const issues = objectiveVsVisibleSurface(bundle.workflow.objective, bundle);

    expect(issues).toEqual([]);
  });

  it('skips gracefully when the extracted surface text is empty', () => {
    const bundle = bundleForSurfaceCheck({
      objective: 'Add export feature button on the dashboard',
      surfaceText: '',
    });

    const issues = objectiveVsVisibleSurface(bundle.workflow.objective, bundle);

    expect(issues).toEqual([]);
  });

  it('skips gracefully when the objective is empty', () => {
    const bundle = bundleForSurfaceCheck({
      objective: '',
      surfaceText: 'Dashboard\nSettings\nLogout',
    });

    const issues = objectiveVsVisibleSurface(bundle.workflow.objective, bundle);

    expect(issues).toEqual([]);
  });

  it('truncates missingClaims to the top 5 entries inside safeContext', () => {
    const bundle = bundleForSurfaceCheck({
      objective:
        'reports analytics metrics charts widgets exports invoices customers products inventory',
      surfaceText: 'Welcome page',
      inspectedFiles: ['C:/project/src/welcome.tsx'],
    });

    const issues = objectiveVsVisibleSurface(bundle.workflow.objective, bundle);

    expect(issues).toHaveLength(1);
    const missingClaims = issues[0].safeContext?.missingClaims as string[];
    expect(missingClaims).toHaveLength(5);
  });

  it('drops common stopwords before comparing against the visible surface', () => {
    const bundle = bundleForSurfaceCheck({
      objective: 'the and or button table',
      surfaceText: 'Button label',
    });

    const issues = objectiveVsVisibleSurface(bundle.workflow.objective, bundle);

    expect(issues).toEqual([]);
  });

  it('matches the surface text case-insensitively', () => {
    const bundle = bundleForSurfaceCheck({
      objective: 'EXPORT BUTTON',
      surfaceText: 'export button',
    });

    const issues = objectiveVsVisibleSurface(bundle.workflow.objective, bundle);

    expect(issues).toEqual([]);
  });
});

describe('reviewFinalProductEvidenceBundle wiring with objectiveVsVisibleSurface', () => {
  it('still blocks when the productHarness has a blocking issue (no regression)', () => {
    const bundle = bundleWithIssue();
    bundle.workflow.objective = 'Add export feature button on the dashboard';
    bundle.productHarness.extractedSurfaceText = 'Dashboard\nSettings\nLogout';

    const result = reviewFinalProductEvidenceBundle(bundle);

    expect(result.outcome).toBe('blocked');
    expect(result.issues.map((i) => i.code)).toContain('sidecar_dom_island');
  });

  it('includes product.objective_visible_mismatch warnings in the returned issues', () => {
    const bundle = bundleForSurfaceCheck({
      objective: 'Add export feature button on the dashboard',
      surfaceText: 'Dashboard\nSettings\nLogout',
    });

    const result = reviewFinalProductEvidenceBundle(bundle);

    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('product.objective_visible_mismatch');
    expect(result.outcome).toBe('needs_fixes');
  });
});
