# Vibe Setup Complete

## Quick Start

```bash
cd apps/vibe
bash start-studio.sh
```

Open `http://127.0.0.1:3333`.

## Manual Start

```bash
cd apps/vibe
npm install
npm run build
npm start
```

## Verification

```bash
npm test
npm run test:e2e
```

- `npm test` runs the local smoke, accessibility, performance, and security checks.
- `npm run test:e2e` runs a self-contained local HTTP/API end-to-end check for the shipped Vibe server and bundle.

## Notes

- `cli:codex` is the standalone local CLI path.
- Shared dashboard and agent routing features still depend on the broader crewswarm stack.
- Built assets are served from `dist/`.
