export async function runCommandSequence({ commands, spawnCommand }) {
  const results = [];
  for (const command of commands) {
    const startedAt = new Date().toISOString();
    const execution = await spawnCommand(command);
    const endedAt = new Date().toISOString();
    const result = {
      name: command.name,
      exitCode: execution.exitCode,
      startedAt,
      endedAt,
      status: execution.exitCode === 0 ? 'passed' : 'failed'
    };
    results.push(result);
    if (execution.exitCode !== 0) {
      return { status: 'failed', failedCommand: command.name, results };
    }
  }
  return { status: 'passed', failedCommand: null, results };
}
