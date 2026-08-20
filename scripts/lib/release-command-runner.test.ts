import { describe, expect, test, vi } from 'vitest';
import { runCommandSequence } from './release-command-runner.mjs';

describe('release command runner', () => {
  test('runs in order and stops on the first non-zero exit', async () => {
    const invoked: string[] = [];
    const spawnCommand = vi.fn(async (command: { name: string }) => {
      invoked.push(command.name);
      return { exitCode: command.name === 'typecheck' ? 2 : 0 };
    });
    const result = await runCommandSequence({
      commands: [{ name: 'lint' }, { name: 'typecheck' }, { name: 'test' }],
      spawnCommand
    });
    expect(invoked).toEqual(['lint', 'typecheck']);
    expect(result).toMatchObject({ status: 'failed', failedCommand: 'typecheck' });
  });

  test('returns a passing result only after every command succeeds', async () => {
    const result = await runCommandSequence({
      commands: [{ name: 'lint' }, { name: 'test' }],
      spawnCommand: () => Promise.resolve({ exitCode: 0 })
    });
    expect(result).toMatchObject({ status: 'passed', failedCommand: null });
    expect(result.results).toHaveLength(2);
  });
});
