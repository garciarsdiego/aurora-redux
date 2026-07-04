# Golden Cases Dataset

This directory contains golden test cases for evaluating the Omniforge Agent's workflow execution capabilities.

## Overview

The `golden-cases.ts` file contains 25 high-quality test cases representing successful workflows across different categories and technology stacks. These cases are used to evaluate the agent's ability to decompose, plan, and execute complex software development tasks.

## File Structure

```
src/v2/evals/datasets/
├── golden-cases.ts    # Main golden cases dataset (25 cases)
└── README.md          # This file
```

## Golden Cases Summary

### Statistics
- **Total Cases**: 25
- **Categories**: 5 (feature-implementation, refactoring, bug-fixing, documentation, testing)
- **Tech Stacks**: React, TypeScript, Node.js, Python, Go, SQL, JavaScript

### Category Breakdown

| Category | Count | Description |
|----------|-------|-------------|
| Feature Implementation | 11 | Building new features, components, APIs |
| Refactoring | 4 | Code improvements, optimizations, cleanups |
| Bug Fixing | 4 | Debugging and fixing issues |
| Documentation | 3 | API docs, user guides, inline documentation |
| Testing | 3 | Unit tests, integration tests, E2E tests |

### Tech Stack Coverage

- **React/TypeScript**: 3 cases (components, forms, dashboards)
- **Node.js/TypeScript**: 3 cases (REST APIs, auth, database)
- **Python**: 3 cases (FastAPI, data processing, testing)
- **Go**: 2 cases (HTTP servers, concurrent patterns)
- **Testing**: 3 cases (Jest, Supertest, Playwright)
- **Documentation**: 3 cases (OpenAPI, user guides, JSDoc)
- **Refactoring**: 4 cases (extract, rename, optimize)
- **Bug Fixing**: 4 cases (null pointer, race conditions, memory leaks, security)

## Case Structure

Each golden case follows the `TestCase` interface defined in `../types.ts`:

```typescript
{
  id: string;              // Unique identifier (e.g., 'gc-react-001')
  workspace: string;       // Workspace name (e.g., 'internal')
  suite: SuiteKind;        // Test suite ('decomposer', 'planner', 'reviewer', 'integration', 'custom')
  name: string;            // Human-readable name
  input: unknown;          // Input data for the test (typically includes objective)
  expected: unknown;       // Expected output/results
  context?: Record<string, unknown>;  // Additional context
  tags: string[];          // Categorization tags
  source: CaseSource;      // Source ('manual', 'synthetic', 'replay')
  created_at: number;      // Unix timestamp
}
```

## Usage

### Importing Golden Cases

```typescript
import { GOLDEN_CASES } from './datasets/golden-cases.js';

// Filter by category
const featureCases = GOLDEN_CASES.filter(c => c.tags.includes('feature-implementation'));

// Filter by tech stack
const reactCases = GOLDEN_CASES.filter(c => c.tags.includes('react'));

// Filter by complexity
const lowComplexity = GOLDEN_CASES.filter(c => c.context?.complexity === 'low');
```

### Running Evaluations

```typescript
import { runEvalSuite } from '../harness.js';
import { GOLDEN_CASES } from './datasets/golden-cases.js';

const run = await runEvalSuite(db, {
  workspace: 'internal',
  suiteName: 'golden-eval',
  caseIds: GOLDEN_CASES.map(c => c.id),
  runner: mySystemUnderTest,
  judge: myJudge
});
```

## Case Quality Criteria

All golden cases satisfy these quality criteria:

1. **Complete**: All required fields present (id, workspace, suite, name, input, expected, tags, source, created_at)
2. **Valid Types**: Suite and source values match enum constraints
3. **Context Rich**: Each case includes descriptive context (complexity, description, estimated duration)
4. **Well Tagged**: Tags include category, tech stack, and relevant characteristics
5. **Realistic**: Represent actual software development scenarios
6. **Verifiable**: Expected outputs are specific and measurable

## Adding New Cases

### Manual Addition

1. Add a new case object to `golden-cases.ts`
2. Ensure all required fields are present
3. Use a unique ID following the pattern: `gc-{tech}-{number}`
4. Include descriptive context and appropriate tags
5. Run validation: `node scripts/validate-golden-cases.mjs`

### Automated Extraction

The `scripts/extract-golden-cases.mjs` script can extract cases from historical workflows:

```bash
node scripts/extract-golden-cases.mjs
```

**Note**: The current database has limited historical data (only 2 completed workflows total). Therefore, the majority of golden cases are synthetic but based on real project patterns and heuristics documented in:
- `docs/TETRIS-DECOMPOSER-ANALYSIS.md` (anti-patterns to avoid)
- `src/brain/decomposer.ts` (heuristics H1-H16)

## Validation

Run the validation script to check case structure:

```bash
node scripts/validate-golden-cases.mjs
```

This validates:
- Required fields presence
- Valid enum values (suite, source)
- Field type consistency
- Category and tech stack coverage

## References

- **Type Definition**: `src/v2/evals/types.ts` (TestCase interface)
- **Existing Golden Suite**: `src/v2/evals/golden-suite.ts` (4 trivial CI cases)
- **Decomposer Heuristics**: `src/brain/decomposer.ts` (H1-H16)
- **Anti-patterns Analysis**: `docs/TETRIS-DECOMPOSER-ANALYSIS.md`

## Future Improvements

1. **Historical Data**: As more workflows are completed, extract real cases from the database
2. **Metrics**: Add performance metrics (actual vs estimated duration, cost)
3. **Variants**: Create variants of cases for A/B testing prompt variations
4. **Evolution**: Use synthetic generation to evolve cases (reasoning, depth, breadth)
5. **Calibration**: Add calibration models for judge scoring

## License

Part of the Omniforge H2 project. See project license for details.