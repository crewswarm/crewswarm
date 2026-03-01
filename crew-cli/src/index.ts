#!/usr/bin/env node

export * from './utils/math.ts';

export function main(): void {
  console.log('Crew CLI ready');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
