#!/usr/bin/env node

/**
 * Seed Test Fixtures Script (Sprint 0)
 *
 * Seeds the database with test fixtures for development and testing.
 */

import { initDb } from '../src/db/client.js';
import { getDbPath } from '../src/utils/config.js';
import {
  DATABASE_FIXTURES,
  createTestWorkflow,
  createTestDAG,
  generateTestEvents,
} from '../tests/fixtures/workflow-fixtures.js';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

async function main() {
  console.log('🌱 Seeding test fixtures...\n');

  const db = initDb(getDbPath());

  try {
    // Seed workspaces
    console.log('📁 Seeding workspaces...');
    for (const workspace of DATABASE_FIXTURES.workspaces) {
      try {
        db.prepare(`
          INSERT INTO dashboard_workspaces (name, created_at, created_by, metadata_json)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET metadata_json = excluded.metadata_json
        `).run(
          workspace.name,
          workspace.created_at,
          workspace.created_by,
          workspace.metadata_json,
        );
        console.log(`  ✅ Workspace: ${workspace.name}`);
      } catch (error) {
        console.log(`  ⚠️  Workspace ${workspace.name} already exists or error: ${error.message}`);
      }
    }

    // Seed workflows
    console.log('\n📋 Seeding workflows...');
    for (const workflow of DATABASE_FIXTURES.workflows) {
      try {
        db.prepare(`
          INSERT INTO workflows (id, objective, workspace, status, created_at, created_by, dag_json, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET objective = excluded.objective
        `).run(
          workflow.id,
          workflow.objective,
          workflow.workspace,
          workflow.status,
          workflow.created_at,
          workflow.created_by,
          workflow.dag_json,
          workflow.metadata_json,
        );
        console.log(`  ✅ Workflow: ${workflow.id}`);
      } catch (error) {
        console.log(`  ⚠️  Workflow ${workflow.id} already exists or error: ${error.message}`);
      }
    }

    // Seed events
    console.log('\n📊 Seeding events...');
    for (const event of DATABASE_FIXTURES.events) {
      try {
        db.prepare(`
          INSERT INTO events (type, workflow_id, timestamp, payload_json)
          VALUES (?, ?, ?, ?)
        `).run(
          event.type,
          event.workflow_id,
          event.timestamp,
          event.payload_json,
        );
        console.log(`  ✅ Event: ${event.type} for ${event.workflow_id}`);
      } catch (error) {
        console.log(`  ⚠️  Event seeding error: ${error.message}`);
      }
    }

    // Create additional test workflows
    console.log('\n🔧 Creating additional test workflows...');
    const testWorkflow1 = createTestWorkflow({
      id: 'test-workflow-sprint0-001',
      objective: 'Sprint 0 integration test workflow',
      expectedTasks: 3,
    });

    try {
      const testDag = createTestDAG(3);
      db.prepare(`
        INSERT INTO workflows (id, objective, workspace, status, created_at, created_by, dag_json, metadata_json)
        VALUES (?, ?, 'internal', 'pending', ?, 'test-fixture', ?, ?)
      `).run(
        testWorkflow1.id,
        testWorkflow1.objective,
        Date.now(),
        JSON.stringify(testDag),
        JSON.stringify({ description: 'Sprint 0 test workflow', fixture: true }),
      );
      console.log(`  ✅ Created test workflow: ${testWorkflow1.id}`);

      // Generate events for the test workflow
      const testEvents = generateTestEvents(testWorkflow1.id, 5);
      for (const event of testEvents) {
        db.prepare(`
          INSERT INTO events (type, workflow_id, timestamp, payload_json)
          VALUES (?, ?, ?, ?)
        `).run(
          event.type,
          event.workflow_id,
          event.timestamp,
          event.payload_json,
        );
      }
      console.log(`  ✅ Generated ${testEvents.length} events for ${testWorkflow1.id}`);
    } catch (error) {
      console.log(`  ⚠️  Test workflow creation error: ${error.message}`);
    }

    // Save fixture metadata
    console.log('\n💾 Saving fixture metadata...');
    const metadata = {
      seededAt: new Date().toISOString(),
      workspacesCount: DATABASE_FIXTURES.workspaces.length,
      workflowsCount: DATABASE_FIXTURES.workflows.length,
      eventsCount: DATABASE_FIXTURES.events.length,
      testWorkflows: 1,
      testEvents: 5,
    };

    const metadataPath = path.join(process.cwd(), 'data', 'test-fixtures-metadata.json');
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    console.log(`  ✅ Fixture metadata saved to: ${metadataPath}`);

    console.log('\n✅ Test fixtures seeded successfully!');
    console.log('\n📊 Summary:');
    console.log(`  Workspaces: ${metadata.workspacesCount}`);
    console.log(`  Workflows: ${metadata.workflowsCount + metadata.testWorkflows}`);
    console.log(`  Events: ${metadata.eventsCount + metadata.testEvents}`);

  } catch (error) {
    console.error('\n❌ Error seeding test fixtures:', error);
    throw error;
  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});