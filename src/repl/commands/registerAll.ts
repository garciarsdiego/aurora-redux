// Registers all 10 MVP slash commands into the global registry.
// Called once at REPL bootstrap before the input loop starts.
import { registerCommand } from './registry.js';
import { helpCommand } from './handlers/help.js';
import { exitCommand } from './handlers/exit.js';
import { statusCommand } from './handlers/status.js';
import { listCommand } from './handlers/list.js';
import { runCommand } from './handlers/run.js';
import { resumeCommand } from './handlers/resume.js';
import { workspaceCommand } from './handlers/workspace.js';
import { modelCommand } from './handlers/model.js';
import { clearCommand } from './handlers/clear.js';
import { historyCommand } from './handlers/history.js';

export function registerAllCommands(): void {
  registerCommand(helpCommand);
  registerCommand(exitCommand);
  registerCommand(statusCommand);
  registerCommand(listCommand);
  registerCommand(runCommand);
  registerCommand(resumeCommand);
  registerCommand(workspaceCommand);
  registerCommand(modelCommand);
  registerCommand(clearCommand);
  registerCommand(historyCommand);
}
