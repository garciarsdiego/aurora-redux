import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const srcDir = 'src/db/migrations';
const dstDir = 'dist/db/migrations';

mkdirSync(dstDir, { recursive: true });

for (const file of readdirSync(srcDir)) {
  copyFileSync(join(srcDir, file), join(dstDir, file));
}
