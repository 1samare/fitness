/* global console, process */
import { spawn } from 'node:child_process';

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const child = spawn(
  pnpmCommand,
  ['--filter', '@fitness/planning-api', 'dev'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      FITNESS_RUNTIME_MODE: 'local',
      FITNESS_LOCAL_USER_ID: 'local-development-user'
    },
    shell: false
  }
);

child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
