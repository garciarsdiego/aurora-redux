/**
 * Golden cases for Omniforge Agent evaluation
 *
 * These cases represent successful workflows across different categories:
 * - Feature implementation (React, Node, Python, Go)
 * - Refactoring (extract module, rename, optimize)
 * - Bug fixing (reproduce, diagnose, fix)
 * - Documentation (API docs, user guides)
 * - Testing (unit tests, integration tests)
 *
 * Source: Synthetic but based on real project patterns and heuristics
 * Reference: docs/TETRIS-DECOMPOSER-ANALYSIS.md (anti-patterns to avoid)
 * Reference: src/brain/decomposer.ts (heuristics H1-H16)
 *
 * Total cases: 25
 */

import type { TestCase } from '../types.js';

export const GOLDEN_CASES: TestCase[] = [
  // ============================================================================
  // FEATURE IMPLEMENTATION - React/TypeScript
  // ============================================================================

  {
    id: 'gc-react-001',
    workspace: 'internal',
    suite: 'integration',
    name: 'feature-implementation: Add user profile component with TypeScript',
    input: {
      objective: 'Add a user profile component with TypeScript that displays user avatar, name, email, and bio',
      workspace: 'internal',
      context: {
        tech_stack: 'react',
        language: 'typescript',
        framework: 'react'
      }
    },
    expected: {
      status: 'completed',
      files_created: ['src/components/UserProfile.tsx', 'src/components/UserProfile.test.tsx'],
      has_types: true,
      has_tests: true,
      task_count: 4,
      completed_tasks: 4
    },
    context: {
      description: 'Simple React component with TypeScript and tests',
      complexity: 'low',
      estimated_duration_ms: 300000
    },
    tags: ['feature-implementation', 'react', 'typescript', 'component', 'tested'],
    source: 'manual',
    created_at: 1716168000
  },

  {
    id: 'gc-react-002',
    workspace: 'internal',
    suite: 'integration',
    name: 'feature-implementation: Build React dashboard with data fetching',
    input: {
      objective: 'Build a React dashboard that fetches user data from API and displays in a table with pagination',
      workspace: 'internal',
      context: {
        tech_stack: 'react',
        api_integration: true,
        pagination: true
      }
    },
    expected: {
      status: 'completed',
      files_created: [
        'src/pages/Dashboard.tsx',
        'src/components/UserTable.tsx',
        'src/components/Pagination.tsx',
        'src/api/users.ts',
        'src/hooks/useUsers.ts'
      ],
      has_api_integration: true,
      has_state_management: true,
      task_count: 6,
      completed_tasks: 6
    },
    context: {
      description: 'Multi-component dashboard with API integration and custom hooks',
      complexity: 'medium',
      estimated_duration_ms: 600000
    },
    tags: ['feature-implementation', 'react', 'api', 'dashboard', 'hooks'],
    source: 'manual',
    created_at: 1716168000
  },

  {
    id: 'gc-react-003',
    workspace: 'internal',
    suite: 'integration',
    name: 'feature-implementation: Implement form validation with React Hook Form',
    input: {
      objective: 'Create a registration form with React Hook Form, Zod validation, and error handling',
      workspace: 'internal',
      context: {
        tech_stack: 'react',
        form_library: 'react-hook-form',
        validation: 'zod'
      }
    },
    expected: {
      status: 'completed',
      files_created: [
        'src/components/RegistrationForm.tsx',
        'src/schemas/registrationSchema.ts',
        'src/components/RegistrationForm.test.tsx'
      ],
      has_validation: true,
      has_error_handling: true,
      task_count: 3,
      completed_tasks: 3
    },
    context: {
      description: 'Form with validation using modern React patterns',
      complexity: 'medium',
      estimated_duration_ms: 400000
    },
    tags: ['feature-implementation', 'react', 'forms', 'validation', 'zod'],
    source: 'manual',
    created_at: 1716168000
  },

  // ============================================================================
  // FEATURE IMPLEMENTATION - Node.js/TypeScript
  // ============================================================================

  {
    id: 'gc-node-001',
    workspace: 'internal',
    suite: 'integration',
    name: 'feature-implementation: Create REST API endpoint with Express',
    input: {
      objective: 'Create a REST API endpoint for user CRUD operations with Express and TypeScript',
      workspace: 'internal',
      context: {
        tech_stack: 'node',
        framework: 'express',
        language: 'typescript'
      }
    },
    expected: {
      status: 'completed',
      files_created: [
        'src/routes/users.ts',
        'src/controllers/userController.ts',
        'src/models/user.ts',
        'src/middleware/validation.ts'
      ],
      has_crud_operations: true,
      has_middleware: true,
      task_count: 5,
      completed_tasks: 5
    },
    context: {
      description: 'REST API with proper separation of concerns',
      complexity: 'medium',
      estimated_duration_ms: 500000
    },
    tags: ['feature-implementation', 'node', 'express', 'rest-api', 'crud'],
    source: 'manual',
    created_at: 1716168000
  },

  {
    id: 'gc-node-002',
    workspace: 'internal',
    suite: 'integration',
    name: 'feature-implementation: Implement authentication with JWT',
    input: {
      objective: 'Add JWT-based authentication with login, register, and token refresh endpoints',
      workspace: 'internal',
      context: {
        tech_stack: 'node',
        auth: 'jwt',
        security: true
      }
    },
    expected: {
      status: 'completed',
      files_created: [
        'src/routes/auth.ts',
        'src/controllers/authController.ts',
        'src/middleware/auth.ts',
        'src/utils/jwt.ts',
        'src/services/authService.ts'
      ],
      has_auth: true,
      has_security: true,
      task_count: 6,
      completed_tasks: 6
    },
    context: {
      description: 'Complete authentication flow with JWT',
      complexity: 'high',
      estimated_duration_ms: 700000
    },
    tags: ['feature-implementation', 'node', 'auth', 'jwt', 'security'],
    source: 'manual',
    created_at: 1716168000
  },

  {
    id: 'gc-node-003',
    workspace: 'internal',
    suite: 'integration',
    name: 'feature-implementation: Add database layer with Prisma',
    input: {
      objective: 'Set up Prisma ORM with PostgreSQL schema and generate client',
      workspace: 'internal',
      context: {
        tech_stack: 'node',
        orm: 'prisma',
        database: 'postgresql'
      }
    },
    expected: {
      status: 'completed',
      files_created: [
        'prisma/schema.prisma',
        'src/lib/prisma.ts',
        'prisma/migrations/initial/migration.sql'
      ],
      has_database: true,
      has_orm: true,
      task_count: 4,
      completed_tasks: 4
    },
    context: {
      description: 'Database setup with Prisma ORM',
      complexity: 'medium',
      estimated_duration_ms: 400000
    },
    tags: ['feature-implementation', 'node', 'prisma', 'database', 'postgresql'],
    source: 'manual',
    created_at: 1716168000
  },

  // ============================================================================
  // FEATURE IMPLEMENTATION - Python
  // ============================================================================

  {
    id: 'gc-python-001',
    workspace: 'internal',
    suite: 'integration',
    name: 'feature-implementation: Create FastAPI endpoint with Pydantic',
    input: {
      objective: 'Create a FastAPI endpoint for user management with Pydantic models',
      workspace: 'internal',
      context: {
        tech_stack: 'python',
        framework: 'fastapi',
        validation: 'pydantic'
      }
    },
    expected: {
      status: 'completed',
      files_created: [
        'app/main.py',
        'app/models/user.py',
        'app/routers/users.py',
        'app/schemas/user.py'
      ],
      has_api: true,
      has_validation: true,
      task_count: 4,
      completed_tasks: 4
    },
    context: {
      description: 'FastAPI with Pydantic validation',
      complexity: 'medium',
      estimated_duration_ms: 400000
    },
    tags: ['feature-implementation', 'python', 'fastapi', 'pydantic', 'api'],
    source: 'manual',
    created_at: 1716168000
  },

  {
    id: 'gc-python-002',
    workspace: 'internal',
    suite: 'integration',
    name: 'feature-implementation: Implement data processing pipeline with Pandas',
    input: {
      objective: 'Create a data processing pipeline that reads CSV, transforms data, and outputs results',
      workspace: 'internal',
      context: {
        tech_stack: 'python',
        libraries: ['pandas', 'numpy'],
        data_processing: true
      }
    },
    expected: {
      status: 'completed',
      files_created: [
        'src/pipeline.py',
        'src/transformers.py',
        'tests/test_pipeline.py'
      ],
      has_data_processing: true,
      has_tests: true,
      task_count: 3,
      completed_tasks: 3
    },
    context: {
      description: 'Data processing pipeline with Pandas',
      complexity: 'medium',
      estimated_duration_ms: 500000
    },
    tags: ['feature-implementation', 'python', 'pandas', 'data-processing', 'etl'],
    source: 'manual',
    created_at: 1716168000
  },

  {
    id: 'gc-python-003',
    workspace: 'internal',
    suite: 'integration',
    name: 'feature-implementation: Add unit tests with pytest',
    input: {
      objective: 'Add comprehensive unit tests for existing Python modules using pytest and fixtures',
      workspace: 'internal',
      context: {
        tech_stack: 'python',
        testing: 'pytest',
        coverage: true
      }
    },
    expected: {
      status: 'completed',
      files_created: [
        'tests/conftest.py',
        'tests/test_module1.py',
        'tests/test_module2.py',
        'tests/fixtures/'
      ],
      has_tests: true,
      has_fixtures: true,
      task_count: 4,
      completed_tasks: 4
    },
    context: {
      description: 'Comprehensive test suite with pytest',
      complexity: 'low',
      estimated_duration_ms: 300000
    },
    tags: ['feature-implementation', 'python', 'testing', 'pytest', 'coverage'],
    source: 'manual',
    created_at: 1716168000
  },

  // ============================================================================
  // FEATURE IMPLEMENTATION - Go
  // ============================================================================

  {
    id: 'gc-go-001',
    workspace: 'internal',
    suite: 'integration',
    name: 'feature-implementation: Create HTTP server with standard library',
    input: {
      objective: 'Create a Go HTTP server with handlers for health check and user endpoints',
      workspace: 'internal',
      context: {
        tech_stack: 'go',
        framework: 'stdlib',
        api: true
      }
    },
    expected: {
      status: 'completed',
      files_created: [
        'cmd/server/main.go',
        'internal/handlers/health.go',
        'internal/handlers/users.go',
        'internal/models/user.go'
      ],
      has_api: true,
      follows_go_layout: true,
      task_count: 4,
      completed_tasks: 4
    },
    context: {
      description: 'Go HTTP server following standard project layout',
      complexity: 'medium',
      estimated_duration_ms: 400000
    },
    tags: ['feature-implementation', 'go', 'http-server', 'stdlib', 'api'],
    source: 'manual',
    created_at: 1716168000
  },

  {
    id: 'gc-go-002',
    workspace: 'internal',
    suite: 'integration',
    name: 'feature-implementation: Implement concurrent worker pool',
    input: {
      objective: 'Implement a concurrent worker pool in Go for processing jobs with goroutines and channels',
      workspace: 'internal',
      context: {
        tech_stack: 'go',
        concurrency: true,
        patterns: ['worker-pool', 'channels']
      }
    },
    expected: {
      status: 'completed',
      files_created: [
        'internal/worker/pool.go',
        'internal/worker/job.go',
        'internal/worker/worker.go',
        'cmd/worker/main.go'
      ],
      has_concurrency: true,
      uses_channels: true,
      task_count: 4,
      completed_tasks: 4
    },
    context: {
      description: 'Concurrent worker pool with goroutines and channels',
      complexity: 'high',
      estimated_duration_ms: 500000
    },
    tags: ['feature-implementation', 'go', 'concurrency', 'worker-pool', 'channels'],
    source: 'manual',
    created_at: 1716168000
  },

  // ============================================================================
  // REFACTORING
  // ============================================================================

  {
    id: 'gc-refactor-001',
    workspace: 'internal',
    suite: 'integration',
    name: 'refactoring: Extract utility functions from large component',
    input: {
      objective: 'Extract utility functions from a large React component into separate helper module',
      workspace: 'internal',
      context: {
        tech_stack: 'typescript',
        refactoring_type: 'extract-function',
        target: 'component'
      }
    },
    expected: {
      status: 'completed',
      files_modified: ['src/components/LargeComponent.tsx'],
      files_created: ['src/utils/componentHelpers.ts'],
      improved_readability: true,
      reduced_component_size: true,
      task_count: 2,
      completed_tasks: 2
    },
    context: {
      description: 'Extract functions to improve component maintainability',
      complexity: 'low',
      estimated_duration_ms: 200000
    },
    tags: ['refactoring', 'typescript', 'extract-function', 'clean-code'],
    source: 'manual',
    created_at: 1716168000
  },

  {
    id: 'gc-refactor-002',
    workspace: 'internal',
    suite: 'integration',
    name: 'refactoring: Rename inconsistent variable names',
    input: {
      objective: 'Rename inconsistently named variables across multiple files to follow naming conventions',
      workspace: 'internal',
      context: {
        tech_stack: 'typescript',
        refactoring_type: 'rename',
        scope: 'multi-file'
      }
    },
    expected: {
      status: 'completed',
      files_modified: ['src/service.ts', 'src/utils.ts', 'src/types.ts'],
    naming_consistent: true,
    all_references_updated: true,
      task_count: 3,
      completed_tasks: 3
    },
    context: {
      description: 'Rename variables for consistency across codebase',
      complexity: 'low',
      estimated_duration_ms: 300000
    },
    tags: ['refactoring', 'typescript', 'rename', 'naming-conventions'],
    source: 'manual',
    created_at: 1716168000
  },

  {
    id: 'gc-refactor-003',
    workspace: 'internal',
    suite: 'integration',
    name: 'refactoring: Optimize database queries with proper indexing',
    input: {
      objective: 'Optimize slow database queries by adding proper indexes and rewriting queries',
      workspace: 'internal',
      context: {
        tech_stack: 'sql',
        refactoring_type: 'optimize',
        target: 'performance'
      }
    },
    expected: {
      status: 'completed',
      files_modified: ['migrations/add_indexes.sql', 'src/queries.ts'],
      performance_improved: true,
      indexes_added: true,
      task_count: 3,
      completed_tasks: 3
    },
    context: {
      description: 'Database query optimization with indexing',
      complexity: 'medium',
      estimated_duration_ms: 400000
    },
    tags: ['refactoring', 'sql', 'performance', 'indexing', 'optimization'],
    source: 'manual',
    created_at: 1716168000
  },

  {
    id: 'gc-refactor-004',
    workspace: 'internal',
    suite: 'integration',
    name: 'refactoring: Extract interface from concrete implementation',
    input: {
      objective: 'Extract interface from concrete class to enable dependency injection and testing',
      workspace: 'internal',
      context: {
        tech_stack: 'typescript',
        refactoring_type: 'extract-interface',
        pattern: 'dependency-injection'
      }
    },
    expected: {
      status: 'completed',
      files_modified: ['src/service/impl.ts'],
      files_created: ['src/service/interface.ts'],
      has_interface: true,
    enables_testing: true,
      task_count: 2,
      completed_tasks: 2
    },
    context: {
      description: 'Extract interface for better testability',
      complexity: 'low',
      estimated_duration_ms: 200000
    },
    tags: ['refactoring', 'typescript', 'extract-interface', 'dependency-injection'],
    source: 'manual',
    created_at: 1716168000
  },

  // ============================================================================
  // BUG FIXING
  // ============================================================================

  {
    id: 'gc-bugfix-001',
    workspace: 'internal',
    suite: 'integration',
    name: 'bug-fixing: Fix null pointer exception in user service',
    input: {
      objective: 'Fix null pointer exception occurring when user ID is not found in database',
      workspace: 'internal',
      context: {
        tech_stack: 'typescript',
        bug_type: 'null-pointer',
        severity: 'high'
      }
    },
    expected: {
      status: 'completed',
      files_modified: ['src/services/userService.ts'],
      bug_fixed: true,
      has_error_handling: true,
      tests_added: true,
      task_count: 3,
      completed_tasks: 3
    },
    context: {
      description: 'Fix null pointer with proper error handling',
      complexity: 'low',
      estimated_duration_ms: 300000
    },
    tags: ['bug-fixing', 'typescript', 'null-pointer', 'error-handling'],
    source: 'manual',
    created_at: 1716168000
  },

  {
    id: 'gc-bugfix-002',
    workspace: 'internal',
    suite: 'integration',
    name: 'bug-fixing: Fix race condition in async function',
    input: {
      objective: 'Fix race condition in async function causing inconsistent data updates',
      workspace: 'internal',
      context: {
        tech_stack: 'javascript',
        bug_type: 'race-condition',
        concurrency: true
      }
    },
    expected: {
      status: 'completed',
      files_modified: ['src/async/dataUpdater.js'],
      race_condition_fixed: true,
      uses_proper_synchronization: true,
      task_count: 2,
      completed_tasks: 2
    },
    context: {
      description: 'Fix race condition with proper synchronization',
      complexity: 'high',
      estimated_duration_ms: 500000
    },
    tags: ['bug-fixing', 'javascript', 'race-condition', 'async', 'concurrency'],
    source: 'manual',
    created_at: 1716168000
  },

  {
    id: 'gc-bugfix-003',
    workspace: 'internal',
    suite: 'integration',
    name: 'bug-fixing: Fix memory leak in event listener',
    input: {
      objective: 'Fix memory leak caused by event listeners not being cleaned up on component unmount',
      workspace: 'internal',
      context: {
        tech_stack: 'react',
        bug_type: 'memory-leak',
        pattern: 'cleanup'
      }
    },
    expected: {
      status: 'completed',
      files_modified: ['src/components/DataFetcher.tsx'],
      memory_leak_fixed: true,
      has_cleanup: true,
      task_count: 2,
      completed_tasks: 2
    },
    context: {
      description: 'Fix memory leak with proper cleanup',
      complexity: 'medium',
      estimated_duration_ms: 300000
    },
    tags: ['bug-fixing', 'react', 'memory-leak', 'cleanup', 'event-listeners'],
    source: 'manual',
    created_at: 1716168000
  },

  {
    id: 'gc-bugfix-004',
    workspace: 'internal',
    suite: 'integration',
    name: 'bug-fixing: Fix SQL injection vulnerability',
    input: {
      objective: 'Fix SQL injection vulnerability in user query function by using parameterized queries',
      workspace: 'internal',
      context: {
        tech_stack: 'sql',
        bug_type: 'security',
        vulnerability: 'sql-injection'
      }
    },
    expected: {
      status: 'completed',
      files_modified: ['src/db/queries.ts'],
      vulnerability_fixed: true,
      uses_parameterized_queries: true,
      security_improved: true,
      task_count: 2,
      completed_tasks: 2
    },
    context: {
      description: 'Fix SQL injection with parameterized queries',
      complexity: 'high',
      estimated_duration_ms: 400000
    },
    tags: ['bug-fixing', 'sql', 'security', 'sql-injection', 'parameterized-queries'],
    source: 'manual',
    created_at: 1716168000
  },

  // ============================================================================
  // DOCUMENTATION
  // ============================================================================

  {
    id: 'gc-docs-001',
    workspace: 'internal',
    suite: 'integration',
    name: 'documentation: Add API documentation with OpenAPI spec',
    input: {
      objective: 'Create comprehensive API documentation using OpenAPI/Swagger specification',
      workspace: 'internal',
      context: {
        tech_stack: 'node',
        doc_type: 'api',
        format: 'openapi'
      }
    },
    expected: {
      status: 'completed',
      files_created: [
        'docs/openapi.yaml',
        'docs/api/endpoints.md',
        'docs/api/authentication.md'
      ],
      has_openapi_spec: true,
      comprehensive: true,
      task_count: 3,
      completed_tasks: 3
    },
    context: {
      description: 'API documentation with OpenAPI specification',
      complexity: 'medium',
      estimated_duration_ms: 400000
    },
    tags: ['documentation', 'api', 'openapi', 'swagger'],
    source: 'manual',
    created_at: 1716168000
  },

  {
    id: 'gc-docs-002',
    workspace: 'internal',
    suite: 'integration',
    name: 'documentation: Write user guide for CLI tool',
    input: {
      objective: 'Write comprehensive user guide for CLI tool with installation, usage examples, and troubleshooting',
      workspace: 'internal',
      context: {
        tech_stack: 'cli',
        doc_type: 'user-guide',
        audience: 'end-users'
      }
    },
    expected: {
      status: 'completed',
      files_created: [
        'docs/user-guide.md',
        'docs/installation.md',
        'docs/examples.md',
        'docs/troubleshooting.md'
      ],
      has_examples: true,
      has_troubleshooting: true,
      task_count: 4,
      completed_tasks: 4
    },
    context: {
      description: 'Comprehensive user guide for CLI tool',
      complexity: 'medium',
      estimated_duration_ms: 500000
    },
    tags: ['documentation', 'cli', 'user-guide', 'examples'],
    source: 'manual',
    created_at: 1716168000
  },

  {
    id: 'gc-docs-003',
    workspace: 'internal',
    suite: 'integration',
    name: 'documentation: Add JSDoc comments to TypeScript modules',
    input: {
      objective: 'Add comprehensive JSDoc comments to all exported functions and classes in TypeScript modules',
      workspace: 'internal',
      context: {
        tech_stack: 'typescript',
        doc_type: 'inline',
        format: 'jsdoc'
      }
    },
    expected: {
      status: 'completed',
      files_modified: ['src/utils/helpers.ts', 'src/services/api.ts'],
      has_jsdoc: true,
      coverage_high: true,
      task_count: 2,
      completed_tasks: 2
    },
    context: {
      description: 'Add JSDoc comments for better IDE support',
      complexity: 'low',
      estimated_duration_ms: 300000
    },
    tags: ['documentation', 'typescript', 'jsdoc', 'inline-docs'],
    source: 'manual',
    created_at: 1716168000
  },

  // ============================================================================
  // TESTING
  // ============================================================================

  {
    id: 'gc-test-001',
    workspace: 'internal',
    suite: 'integration',
    name: 'testing: Add unit tests for React components with Jest',
    input: {
      objective: 'Add unit tests for React components using Jest and React Testing Library',
      workspace: 'internal',
      context: {
        tech_stack: 'react',
        testing_framework: 'jest',
        library: 'react-testing-library'
      }
    },
    expected: {
      status: 'completed',
      files_created: [
        'src/components/Button.test.tsx',
        'src/components/Input.test.tsx',
        'src/components/Form.test.tsx'
      ],
      has_tests: true,
      coverage_good: true,
      task_count: 3,
      completed_tasks: 3
    },
    context: {
      description: 'Unit tests for React components',
      complexity: 'medium',
      estimated_duration_ms: 400000
    },
    tags: ['testing', 'react', 'jest', 'react-testing-library', 'unit-tests'],
    source: 'manual',
    created_at: 1716168000
  },

  {
    id: 'gc-test-002',
    workspace: 'internal',
    suite: 'integration',
    name: 'testing: Add integration tests for API endpoints',
    input: {
      objective: 'Add integration tests for REST API endpoints using Supertest',
      workspace: 'internal',
      context: {
        tech_stack: 'node',
        testing_framework: 'jest',
        library: 'supertest',
        test_type: 'integration'
      }
    },
    expected: {
      status: 'completed',
      files_created: [
        'tests/integration/api.test.ts',
        'tests/integration/auth.test.ts',
        'tests/integration/users.test.ts'
      ],
      has_integration_tests: true,
      covers_crud: true,
      task_count: 3,
      completed_tasks: 3
    },
    context: {
      description: 'Integration tests for API endpoints',
      complexity: 'high',
      estimated_duration_ms: 500000
    },
    tags: ['testing', 'node', 'jest', 'supertest', 'integration-tests'],
    source: 'manual',
    created_at: 1716168000
  },

  {
    id: 'gc-test-003',
    workspace: 'internal',
    suite: 'integration',
    name: 'testing: Add E2E tests with Playwright',
    input: {
      objective: 'Add end-to-end tests for critical user flows using Playwright',
      workspace: 'internal',
      context: {
        tech_stack: 'web',
        testing_framework: 'playwright',
        test_type: 'e2e'
      }
    },
    expected: {
      status: 'completed',
      files_created: [
        'e2e/login.spec.ts',
        'e2e/checkout.spec.ts',
        'e2e/user-profile.spec.ts',
        'playwright.config.ts'
      ],
      has_e2e_tests: true,
      covers_critical_flows: true,
      task_count: 4,
      completed_tasks: 4
    },
    context: {
      description: 'E2E tests for critical user flows',
      complexity: 'high',
      estimated_duration_ms: 600000
    },
    tags: ['testing', 'playwright', 'e2e', 'browser-automation'],
    source: 'manual',
    created_at: 1716168000
  }
];

export default GOLDEN_CASES;