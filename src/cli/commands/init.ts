import type { Command } from 'commander';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_TEMPLATE = `# workspaces/{name}/.env
# Adicione as creds deste workspace aqui.
# Este arquivo NAO e commitado (ver .gitignore).
#
# Exemplos:
# GOOGLE_ADS_REFRESH_TOKEN=
# GOOGLE_ADS_CLIENT_ID=
# GOOGLE_ADS_CLIENT_SECRET=
# GOOGLE_ADS_DEVELOPER_TOKEN=
# GOOGLE_ADS_CUSTOMER_ID=
#
# Omniroute (herda do .env raiz se nao definido aqui):
# OMNIROUTE_URL=http://localhost:20228
# DECOMPOSER_MODEL=claude/claude-opus-4-6
# TASK_MODEL=claude/claude-sonnet-4-6
# REVIEWER_MODEL=claude/claude-sonnet-4-6
# CONSOLIDATOR_MODEL=claude/claude-sonnet-4-6
`;

const HITL_TEMPLATE = JSON.stringify(
  { channel: 'cli', auto_approve_if: {} },
  null,
  2,
) + '\n';

export function registerInit(program: Command): void {
  program
    .command('init <workspace>')
    .description('Initialize a workspace directory')
    .action((workspace: string) => {
      const dir = resolve('workspaces', workspace);
      const patternsDir = resolve(dir, 'patterns');
      const envPath = resolve(dir, '.env');
      const hitlPath = resolve(dir, '.hitl.json');

      mkdirSync(dir, { recursive: true });
      mkdirSync(patternsDir, { recursive: true });

      if (!existsSync(envPath)) {
        writeFileSync(envPath, ENV_TEMPLATE.replace('{name}', workspace));
      }
      if (!existsSync(hitlPath)) {
        writeFileSync(hitlPath, HITL_TEMPLATE);
      }

      console.log(`✓ Workspace '${workspace}' inicializado`);
      console.log(`  Pasta:  ${dir}`);
      console.log(`  .env:   ${envPath}   <- edite com suas creds`);
      console.log(`  HITL:   ${hitlPath}`);
    });
}
