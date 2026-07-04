/**
 * Test Data Fixtures for Workflows (Sprint 0)
 * 
 * Provides test data and fixtures for workflow testing.
 * Includes sample workflows, DAGs, and test scenarios.
 */

export interface WorkflowFixture {
  id: string;
  objective: string;
  workspace: string;
  expectedTasks: number;
  description: string;
}

export interface TaskFixture {
  id: string;
  type: string;
  description: string;
  expectedDuration: number; // milliseconds
}

export interface DAGFixture {
  workflowId: string;
  dag: {
    nodes: Array<{
      id: string;
      type: string;
      data: Record<string, unknown>;
    }>;
    edges: Array<{
      from: string;
      to: string;
    }>;
  };
}

/**
 * Simple workflow fixtures for basic testing
 */
export const SIMPLE_WORKFLOW_FIXTURES: WorkflowFixture[] = [
  {
    id: 'test-workflow-simple-001',
    objective: 'Test basic LLM call functionality',
    workspace: 'internal',
    expectedTasks: 1,
    description: 'Single task workflow to test basic LLM call',
  },
  {
    id: 'test-workflow-simple-002',
    objective: 'Test file write operation',
    workspace: 'internal',
    expectedTasks: 2,
    description: 'Two task workflow: LLM call + file write',
  },
  {
    id: 'test-workflow-simple-003',
    objective: 'Test command execution',
    workspace: 'internal',
    expectedTasks: 2,
    description: 'Two task workflow: LLM call + bash command',
  },
];

/**
 * Complex workflow fixtures for advanced testing
 */
export const COMPLEX_WORKFLOW_FIXTURES: WorkflowFixture[] = [
  {
    id: 'test-workflow-complex-001',
    objective: 'Test multi-step analysis workflow',
    workspace: 'internal',
    expectedTasks: 5,
    description: 'Five task workflow with dependencies and consolidation',
  },
  {
    id: 'test-workflow-complex-002',
    objective: 'Test error handling and retry logic',
    workspace: 'internal',
    expectedTasks: 4,
    description: 'Workflow with intentional failures to test retry behavior',
  },
  {
    id: 'test-workflow-complex-003',
    objective: 'Test parallel task execution',
    workspace: 'internal',
    expectedTasks: 6,
    description: 'Six task workflow with parallel execution paths',
  },
];

/**
 * Task fixtures for testing individual task types
 */
export const TASK_FIXTURES: TaskFixture[] = [
  {
    id: 'task-llm-call-001',
    type: 'llm_call',
    description: 'Basic LLM call with simple prompt',
    expectedDuration: 2000,
  },
  {
    id: 'task-file-write-001',
    type: 'file_write',
    description: 'Write text content to a file',
    expectedDuration: 100,
  },
  {
    id: 'task-file-read-001',
    type: 'file_read',
    description: 'Read content from a file',
    expectedDuration: 50,
  },
  {
    id: 'task-bash-001',
    type: 'bash',
    description: 'Execute simple bash command',
    expectedDuration: 500,
  },
  {
    id: 'task-http-request-001',
    type: 'http_request',
    description: 'Make HTTP GET request',
    expectedDuration: 1000,
  },
];

/**
 * DAG fixtures for testing workflow structure
 */
export const DAG_FIXTURES: DAGFixture[] = [
  {
    workflowId: 'test-dag-linear-001',
    dag: {
      nodes: [
        {
          id: 'task-1',
          type: 'llm_call',
          data: { prompt: 'Test prompt 1' },
        },
        {
          id: 'task-2',
          type: 'file_write',
          data: { path: 'test.txt', content: 'Test content' },
        },
        {
          id: 'task-3',
          type: 'bash',
          data: { command: 'echo "Done"' },
        },
      ],
      edges: [
        { from: 'task-1', to: 'task-2' },
        { from: 'task-2', to: 'task-3' },
      ],
    },
  },
  {
    workflowId: 'test-dag-parallel-001',
    dag: {
      nodes: [
        {
          id: 'task-1',
          type: 'llm_call',
          data: { prompt: 'Test prompt 1' },
        },
        {
          id: 'task-2a',
          type: 'file_write',
          data: { path: 'test-a.txt', content: 'Test A' },
        },
        {
          id: 'task-2b',
          type: 'file_write',
          data: { path: 'test-b.txt', content: 'Test B' },
        },
        {
          id: 'task-3',
          type: 'bash',
          data: { command: 'echo "Parallel done"' },
        },
      ],
      edges: [
        { from: 'task-1', to: 'task-2a' },
        { from: 'task-1', to: 'task-2b' },
        { from: 'task-2a', to: 'task-3' },
        { from: 'task-2b', to: 'task-3' },
      ],
    },
  },
];

/**
 * Test data for database seeding
 */
export const DATABASE_FIXTURES = {
  workspaces: [
    {
      name: 'test-workspace',
      created_at: Date.now(),
      created_by: 'test-fixture',
      metadata_json: JSON.stringify({
        description: 'Test workspace for Sprint 0',
        software_target: {
          project_root: '/tmp/test-workspace',
        },
      }),
    },
  ],
  workflows: [
    {
      id: 'test-workflow-001',
      objective: 'Test workflow fixture 001',
      workspace: 'test-workspace',
      status: 'pending',
      created_at: Date.now(),
      created_by: 'test-fixture',
      dag_json: JSON.stringify(DAG_FIXTURES[0].dag),
      metadata_json: JSON.stringify({
        description: 'Test workflow for Sprint 0',
        fixture: true,
      }),
    },
  ],
  events: [
    {
      type: 'workflow_started',
      workflow_id: 'test-workflow-001',
      timestamp: Date.now(),
      payload_json: JSON.stringify({
        source: 'test-fixture',
      }),
    },
  ],
};

/**
 * Performance test fixtures
 */
export const PERFORMANCE_FIXTURES = {
  smallWorkflow: {
    tasks: 3,
    estimatedDuration: 5000, // 5 seconds
    description: 'Small workflow for performance baseline',
  },
  mediumWorkflow: {
    tasks: 10,
    estimatedDuration: 30000, // 30 seconds
    description: 'Medium workflow for load testing',
  },
  largeWorkflow: {
    tasks: 50,
    estimatedDuration: 120000, // 2 minutes
    description: 'Large workflow for stress testing',
  },
};

/**
 * Error scenario fixtures
 */
export const ERROR_SCENARIO_FIXTURES = [
  {
    id: 'error-scenario-001',
    description: 'LLM API timeout',
    trigger: 'Simulate API timeout',
    expectedBehavior: 'Retry with exponential backoff',
  },
  {
    id: 'error-scenario-002',
    description: 'File permission denied',
    trigger: 'Attempt to write to protected path',
    expectedBehavior: 'Graceful error handling with user notification',
  },
  {
    id: 'error-scenario-003',
    description: 'Invalid command execution',
    trigger: 'Execute malformed bash command',
    expectedBehavior: 'Command failure with proper error reporting',
  },
  {
    id: 'error-scenario-004',
    description: 'Network connection failure',
    trigger: 'HTTP request to unreachable endpoint',
    expectedBehavior: 'Connection error with retry logic',
  },
];

/**
 * HITL (Human-in-the-Loop) test fixtures
 */
export const HITL_FIXTURES = [
  {
    id: 'hitl-scenario-001',
    description: 'Simple approval gate',
    workflowId: 'test-hitl-001',
    gateType: 'approval',
    timeoutMs: 60000, // 1 minute
    expectedDecisions: ['approve', 'reject'],
  },
  {
    id: 'hitl-scenario-002',
    description: 'Modification gate',
    workflowId: 'test-hitl-002',
    gateType: 'modify',
    timeoutMs: 120000, // 2 minutes
    expectedDecisions: ['modify', 'approve', 'reject'],
  },
];

/**
 * Monitoring and observability test fixtures
 */
export const MONITORING_FIXTURES = {
  healthCheck: {
    endpoint: '/health',
    expectedFields: ['status', 'version', 'uptime_ms', 'api_version'],
    expectedStatus: 'ok',
  },
  monitoringDashboard: {
    endpoint: '/api/monitoring/dashboard',
    expectedSections: [
      'system_health',
      'performance',
      'workflows',
      'llm_usage',
      'persona_metrics',
    ],
  },
  tracing: {
    workflowId: 'test-trace-001',
    expectedSpans: 5,
    expectedKinds: ['workflow', 'task', 'llm_call'],
  },
  logs: {
    testMessage: 'Test log message for Sprint 0',
    testContext: 'test-fixture',
    expectedLevels: ['debug', 'info', 'warn', 'error'],
  },
};

/**
 * Helper function to create a test workflow
 */
export function createTestWorkflow(overrides: Partial<WorkflowFixture> = {}): WorkflowFixture {
  const defaults: WorkflowFixture = {
    id: `test-workflow-${Date.now()}`,
    objective: 'Test objective',
    workspace: 'internal',
    expectedTasks: 1,
    description: 'Test workflow created by fixture',
  };

  return { ...defaults, ...overrides };
}

/**
 * Helper function to create a test DAG
 */
export function createTestDAG(taskCount: number): DAGFixture['dag'] {
  const nodes = Array.from({ length: taskCount }, (_, i) => ({
    id: `task-${i + 1}`,
    type: i === 0 ? 'llm_call' : 'bash',
    data: i === 0 
      ? { prompt: `Test prompt ${i + 1}` }
      : { command: `echo "Task ${i + 1}"` },
  }));

  const edges = nodes.slice(0, -1).map((node, i) => ({
    from: node.id,
    to: nodes[i + 1].id,
  }));

  return { nodes, edges };
}

/**
 * Helper function to generate test events
 */
export function generateTestEvents(workflowId: string, count: number = 10) {
  const events = [];
  const eventTypes = [
    'workflow_started',
    'task_started',
    'task_completed',
    'llm_call',
    'tool_call',
    'workflow_completed',
  ];

  for (let i = 0; i < count; i++) {
    events.push({
      type: eventTypes[i % eventTypes.length],
      workflow_id: workflowId,
      timestamp: Date.now() + (i * 1000),
      payload_json: JSON.stringify({
        sequence: i,
        test: true,
      }),
    });
  }

  return events;
}

/**
 * Export all fixtures
 */
export const ALL_FIXTURES = {
  simpleWorkflows: SIMPLE_WORKFLOW_FIXTURES,
  complexWorkflows: COMPLEX_WORKFLOW_FIXTURES,
  tasks: TASK_FIXTURES,
  dags: DAG_FIXTURES,
  database: DATABASE_FIXTURES,
  performance: PERFORMANCE_FIXTURES,
  errorScenarios: ERROR_SCENARIO_FIXTURES,
  hitl: HITL_FIXTURES,
  monitoring: MONITORING_FIXTURES,
};