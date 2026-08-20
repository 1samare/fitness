import { describe, expect, test } from 'vitest';
import {
  RELEASE_CHECK_COMMAND_NAMES,
  runReleaseCheck
} from './release-check.mjs';

describe('release check orchestration', () => {
  test('uses the exact fail-fast release order', async () => {
    const invoked: string[] = [];
    const report = await runReleaseCheck({
      runCommand: (command: { name: string }) => {
        invoked.push(command.name);
        return Promise.resolve({ exitCode: 0, output: command.name === 'git status --short' ? '' : '' });
      },
      writeEvidence: () => Promise.resolve()
    });
    expect(invoked).toEqual(RELEASE_CHECK_COMMAND_NAMES);
    expect(report.status).toBe('passed');
  });

  test('stops at the first failure and writes no passing evidence', async () => {
    const invoked: string[] = [];
    let evidenceWrites = 0;
    const report = await runReleaseCheck({
      runCommand: (command: { name: string }) => {
        invoked.push(command.name);
        return Promise.resolve({
          exitCode: command.name === 'build' ? 1 : 0,
          output: ''
        });
      },
      writeEvidence: () => {
        evidenceWrites += 1;
        return Promise.resolve();
      }
    });
    expect(invoked).toEqual(RELEASE_CHECK_COMMAND_NAMES.slice(0, 5));
    expect(report).toMatchObject({ status: 'failed', failedCommand: 'build' });
    expect(evidenceWrites).toBe(0);
  });

  test.each([
    [' M package.json'],
    ['?? untracked-release-input.json'],
    ['?? .pnpm-store/\n M README.md']
  ])('rejects dirty release sources: %s', async (statusOutput) => {
    const report = await runReleaseCheck({
      runCommand: (command: { name: string }) => Promise.resolve({
        exitCode: 0,
        output: command.name === 'git status --short' ? statusOutput : ''
      }),
      writeEvidence: () => Promise.resolve()
    });
    expect(report.status).toBe('failed');
    expect(report.failedCommand).toBe('git status --short');
  });

  test('allows only the pre-existing untracked pnpm store', async () => {
    const report = await runReleaseCheck({
      runCommand: (command: { name: string }) => Promise.resolve({
        exitCode: 0,
        output: command.name === 'git status --short' ? '?? .pnpm-store/' : ''
      }),
      writeEvidence: () => Promise.resolve()
    });
    expect(report.status).toBe('passed');
  });
});
