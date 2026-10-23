import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Documentation contract: README, AGENTS, and the SDD all claim lint, build,
// test, and naming run on every push and pull request. This test fails if the
// workflow file disappears or the gate order drifts, so the claim cannot go
// stale silently again.

const workflowPath = join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml');

describe('CI workflow contract', () => {
  it('runs the four documented gate commands in order', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const commands = ['npm run lint', 'npm run build', 'npm test', 'npm run namingLinter'];
    let searchFrom = 0;
    for (const command of commands) {
      const index = workflow.indexOf(command, searchFrom);
      expect(index, `missing or out of order: ${command}`).toBeGreaterThanOrEqual(0);
      searchFrom = index + command.length;
    }
  });
});
