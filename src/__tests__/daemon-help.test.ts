import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const daemonBin = join(import.meta.dirname, '../../dist/daemon.js');

describe('sisyphusd --help output', () => {
  for (const flag of ['--help', 'help']) {
    it(`${flag}: exits 0 with no [ISO] timestamp prefix on any line`, () => {
      const result = spawnSync(process.execPath, [daemonBin, flag], { encoding: 'utf8' });
      assert.equal(result.status, 0, `expected exit 0 for ${flag}`);
      const lines = result.stdout.split('\n');
      for (const line of lines) {
        assert.ok(!line.startsWith('['), `line should not start with '[': ${line}`);
      }
      assert.ok(result.stdout.includes('sisyphusd:'), 'output should begin with sisyphusd:');
    });
  }

  it('-h short alias is not recognized (spec: no short aliases)', () => {
    const result = spawnSync(process.execPath, [daemonBin, '-h'], { encoding: 'utf8' });
    assert.equal(result.status, 2, 'expected exit 2 for unknown short alias');
    assert.ok(result.stderr.includes('-h'), 'stderr should mention the unknown command');
  });

  it('unknown command: exits exactly 2 with error mentioning the command', () => {
    const result = spawnSync(process.execPath, [daemonBin, 'bogus-command'], { encoding: 'utf8' });
    assert.equal(result.status, 2, 'expected exit 2 for unknown command (spec contract)');
    assert.ok(result.stderr.includes('bogus-command'), 'stderr should mention the unknown command');
  });
});
