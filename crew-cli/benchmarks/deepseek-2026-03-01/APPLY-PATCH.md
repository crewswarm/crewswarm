# Apply DeepSeek Fix Patch

Target project root:
- `/Users/jeffhobbs/Desktop/benchmark-vscode-deepseek-20260301`

Patch file:
- `benchmarks/deepseek-2026-03-01/deepseek-vscode-extension-fixes.patch`

## Apply
```bash
cd /Users/jeffhobbs/Desktop/benchmark-vscode-deepseek-20260301
git apply /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/benchmarks/deepseek-2026-03-01/deepseek-vscode-extension-fixes.patch
```

## Verify
```bash
npm install
npm run compile
npm run test
```

## Optional smoke run (Extension Development Host)
1. Press `F5`.
2. Run command: `CrewSwarm: Open Chat`.
3. Send a prompt and verify assistant response renders.
4. If diff actions are returned, click `Apply Diff` and confirm result toast/message.
