#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { main } from '../dist/crew.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}
