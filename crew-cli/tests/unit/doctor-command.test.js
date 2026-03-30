import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerDoctorCommands } from '../../src/cli/commands/doctor.ts';

describe('doctor-command', () => {
  it('should export registerDoctorCommands as a function', () => {
    assert.equal(typeof registerDoctorCommands, 'function');
  });

  it('registerDoctorCommands expects 2 arguments', () => {
    assert.equal(registerDoctorCommands.length, 2);
  });
});
