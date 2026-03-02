# Apply Gemini Fix Patch

Target project root:
- `/Users/jeffhobbs/Desktop/benchmark-vscode-gemini-20260301`

Apply:

```bash
cd /Users/jeffhobbs/Desktop/benchmark-vscode-gemini-20260301
git apply /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/benchmarks/gemini-2026-03-01/gemini-vscode-extension-fixes.patch
```

Then validate:

```bash
npm install
npm run compile
```

Optional smoke run (inside VS Code Extension Development Host):
1. Press `F5`.
2. Run command: `Crew AI: Start Chat`.
3. Send a prompt and verify reply rendering.
4. If diff content is returned, click `Apply Diff` with an active editor open.
