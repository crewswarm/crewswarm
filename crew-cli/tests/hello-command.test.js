// tests/hello-command.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exec } from 'node:child_process';

test('hello command prints "hello" and exits with code 0', (t, done) => {
  exec('node bin/crew.js hello', (error, stdout, stderr) => {
    assert.strictEqual(stdout, 'hello\\n', 'stdout should be "hello\\n" for direct invocation');
    assert.strictEqual(stderr, '', 'stderr should be empty for direct invocation');
    assert.strictEqual(error, null, 'direct invocation should exit without error');
    done();
  });
});

test('installed invocation "crew hello" prints "hello" and exits with code 0', (t, done) => {
  exec('npm exec crew hello', (error, stdout, stderr) => {
    assert.strictEqual(stdout, 'hello\\n', 'stdout should be "hello\\n" for installed invocation');
    assert.strictEqual(stderr, '', 'stderr should be empty for installed invocation');
    assert.strictEqual(error, null, 'installed invocation should exit without error');
    done();
  });
});

test('existing command "--help" behavior is unchanged', (t, done) => {
  // Capture baseline for --help
  exec('node bin/crew.js --help', (baselineError, baselineStdout, baselineStderr) => {
    // Execute hello command (no-op for this test, just to ensure it doesn't break anything)
    exec('node bin/crew.js hello', (helloError, helloStdout, helloStderr) => {
      // Re-capture --help output after hello command
      exec('node bin/crew.js --help', (afterHelloError, afterHelloStdout, afterHelloStderr) => {
        assert.strictEqual(afterHelloStdout, baselineStdout, 'stdout for --help should be unchanged');
        assert.strictEqual(afterHelloStderr, baselineStderr, 'stderr for --help should be unchanged');
        assert.strictEqual(afterHelloError, baselineError, 'exit code for --help should be unchanged');
        done();
      });
    });
  });
});