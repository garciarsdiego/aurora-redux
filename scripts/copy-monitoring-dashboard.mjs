import { copyFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const source = join(__dirname, '..', 'src', 'mcp', 'monitoring-dashboard.html');
const dest = join(__dirname, '..', 'dist', 'mcp', 'monitoring-dashboard.html');

if (existsSync(source)) {
  copyFileSync(source, dest);
  console.log('Monitoring dashboard HTML copied to dist/mcp/');
} else {
  console.warn('Monitoring dashboard HTML not found, skipping copy');
}