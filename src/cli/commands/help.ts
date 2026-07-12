// Enhanced help command with examples and common workflows
import type { Command } from 'commander';

const COMMON_WORKFLOWS = [
  {
    name: 'Quick Start',
    description: 'Run a simple workflow with auto-approval',
    command: './bin/omniforge run "your objective" --workspace internal --auto-approve',
  },
  {
    name: 'Plan Before Run',
    description: 'Review DAG summary and confirm before executing (run-dag only)',
    command: './bin/omniforge run-dag your-dag.yaml --workspace internal --plan',
  },
  {
    name: 'Monitor Progress',
    description: 'Check workflow status in real-time',
    command: './bin/omniforge status <workflow_id>',
  },
  {
    name: 'Resume Stuck Workflow',
    description: 'Resume a workflow that was interrupted',
    command: './bin/omniforge resume <workflow_id>',
  },
  {
    name: 'Run from File',
    description: 'Run workflow objective from a text file',
    command: 'node scripts/run-wf-from-file.mjs internal objective.txt --auto-approve',
  },
];

const COMMON_ISSUES = [
  {
    issue: 'Daemon won\'t start',
    solution: 'Check if port 20129 is in use: ./bin/omniforge daemon status',
  },
  {
    issue: 'Workflow stuck in pending',
    solution: 'Restart daemon: ./bin/omniforge daemon restart',
  },
  {
    issue: 'CLI/provider da task falhou',
    solution: 'Rode ./bin/omniforge doctor e confira TASK_MODEL/REVIEWER_MODEL no .env',
  },
  {
    issue: 'CLI binary not found',
    solution: 'Run doctor: ./bin/omniforge doctor',
  },
];

const RESOURCES = [
  { name: 'User Guide', path: 'docs/USER-GUIDE.md' },
  { name: 'API Documentation', path: 'docs/API-DOCUMENTATION.md' },
  { name: 'Troubleshooting Guide', path: 'docs/TROUBLESHOOTING-GUIDE.md' },
  { name: 'Best Practices', path: 'docs/BEST-PRACTICES.md' },
  { name: 'Development Setup', path: 'docs/DEVELOPMENT-SETUP-GUIDE.md' },
];

export function registerHelp(program: Command): void {
  program
    .command('help [command]')
    .description('Show enhanced help with examples and workflows')
    .action((commandName: string | undefined) => {
      if (commandName) {
        // Show help for specific command
        const cmd = program.commands.find((c) => c.name() === commandName);
        if (cmd) {
          cmd.help();
        } else {
          console.error(`Unknown command: ${commandName}`);
          console.log('');
          console.log('Available commands:');
          program.commands.forEach((c) => {
            console.log(`  ${c.name().padEnd(20)} ${c.description()}`);
          });
          process.exit(1);
        }
      } else {
        // Show enhanced help
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════════╗');
        console.log('║                    Omniforge CLI Help                         ║');
        console.log('╚════════════════════════════════════════════════════════════════╝');
        console.log('');
        
        console.log('📚 Common Workflows');
        console.log('─────────────────────────────────────────────────────────────────');
        for (const workflow of COMMON_WORKFLOWS) {
          console.log('');
          console.log(`  ${workflow.name}`);
          console.log(`    ${workflow.description}`);
          console.log(`    $ ${workflow.command}`);
        }
        
        console.log('');
        console.log('🔧 Common Issues & Solutions');
        console.log('─────────────────────────────────────────────────────────────────');
        for (const { issue, solution } of COMMON_ISSUES) {
          console.log('');
          console.log(`  Issue: ${issue}`);
          console.log(`  Solution: ${solution}`);
        }
        
        console.log('');
        console.log('📖 Documentation Resources');
        console.log('─────────────────────────────────────────────────────────────────');
        for (const resource of RESOURCES) {
          console.log(`  ${resource.name.padEnd(30)} ${resource.path}`);
        }
        
        console.log('');
        console.log('🔍 Diagnostic Tools');
        console.log('─────────────────────────────────────────────────────────────────');
        console.log('  ./bin/omniforge doctor          Run local diagnostics');
        console.log('');
        
        console.log('🚀 Quick Commands');
        console.log('─────────────────────────────────────────────────────────────────');
        console.log('  ./bin/omniforge run <objective>  Run a workflow');
        console.log('  ./bin/omniforge status           Show last workflow status');
        console.log('  ./bin/omniforge list             List recent workflows');
        console.log('  ./bin/omniforge daemon start     Start the daemon');
        console.log('  ./bin/omniforge daemon stop      Stop the daemon');
        console.log('  ./bin/omniforge repl             Open interactive REPL');
        console.log('');
        
        console.log('💡 Tips');
        console.log('─────────────────────────────────────────────────────────────────');
        console.log('  • Use --auto-approve to skip HITL gates for trusted workflows');
        console.log('  • Use --workspace to specify the workspace (internal, initech, etc.)');
        console.log('  • Run doctor if you encounter any issues');
        console.log('  • Check docs/TROUBLESHOOTING-GUIDE.md for detailed help');
        console.log('');
        
        console.log('For command-specific help, use:');
        console.log('  ./bin/omniforge help <command>');
        console.log('');
        console.log('Or use --help flag on any command:');
        console.log('  ./bin/omniforge run --help');
        console.log('');
      }
    });
}