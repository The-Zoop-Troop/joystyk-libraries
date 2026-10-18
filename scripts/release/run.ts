import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from './packages.ts';

const exec = promisify(execFile);
export const run = (file: string, args: readonly string[], cwd = ROOT) =>
  exec(file, [...args], {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CI: 'true', npm_config_audit: 'false', npm_config_fund: 'false' },
  });
