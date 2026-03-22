# Contributing to crew-cli

Thank you for your interest in improving `crew-cli`! 

## Development Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. We use `tsx` for running TypeScript files directly during development and tests.

## Architecture Guidelines

- **TypeScript First**: All new code should be written in TypeScript (`src/**/*.ts`).
- **ES Modules**: We strictly use NodeNext module resolution. Ensure your imports include `.js` extensions (e.g., `import { Logger } from './logger.js';`).
- **Safety**: Do not execute arbitrary shell commands blindly. Use the Sandbox for code edits and prompt for confirmation before applying dangerous changes.

## Testing

Before submitting a PR, ensure all tests pass:

```bash
npm test
```

To add tests, create a new file in `tests/` ending with `.test.js` (we use `.js` extension with `tsx` loader to match the runtime). We use the native Node.js test runner (`node:test`).

## Building

To build the CLI for production:

```bash
npm run build
```

This uses `esbuild` to bundle the application into a single ES module `dist/crew.mjs`.

## Code Style

- Use `eslint` to validate styling: `npm run lint`
- Prefer functional/pure methods where possible, except for state managers (like `Sandbox` or `SessionManager`).
