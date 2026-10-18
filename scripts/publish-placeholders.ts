import { spawn } from 'node:child_process';
import { bootstrapPlaceholders, packageExists } from './release/placeholders.ts';
import { ROOT } from './release/packages.ts';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--publish')) throw new Error('Usage: pnpm release:bootstrap [--publish]');

await bootstrapPlaceholders({
  publish: args.includes('--publish'),
  lookup: packageExists,
  log: console.log,
  npm: (command) =>
    new Promise<void>((resolve, reject) => {
      // Inherit the terminal so npm can request the owner's browser login or 2FA challenge.
      const child = spawn('pnpm', ['exec', 'npm', ...command], { cwd: ROOT, stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`npm exited ${String(code)}`))));
    }),
});
