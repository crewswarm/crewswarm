#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '..', 'crew-cli', 'bin', 'crew.js');

spawn('node', [cliPath, ...process.argv.slice(2)], { stdio: 'inherit' })
  .on('exit', code => process.exit(code || 0));
