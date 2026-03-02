import * as vscode from 'vscode';

export class DiffHandler {
  applyToActive(diff: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor to apply diff.');
      return;
    }

    vscode.window.showInformationMessage('Applying diff to active file...', 'Apply', 'Cancel').then(async (choice) => {
      if (choice === 'Cancel') return;

      // Improved unified diff parser for multiple hunks
      const lines = diff.split('\n');
      const edits: { range: vscode.Range; newText: string }[] = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.startsWith('@@')) {
          const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
          if (match) {
            const oldStart = parseInt(match[1]) - 1;
            const oldCount = match[2] ? parseInt(match[2]) : 1;
            const hunkNewLines: string[] = [];
            i++; // move to next line after @@
            while (i < lines.length && !lines[i].startsWith('@@')) {
              const l = lines[i];
              if (l.startsWith('\\ No newline')) {
                // skip
              } else if (!l.startsWith('-')) {
                if (l.startsWith('+')) {
                  hunkNewLines.push(l.slice(1));
                } else {
                  hunkNewLines.push(l);
                }
              }
              i++;
            }
            const range = new vscode.Range(oldStart, 0, oldStart + oldCount, 0);
            edits.push({ range, newText: hunkNewLines.join('\n') });
            continue;
          }
        }
        i++;
      }

      const doc = editor.document;
      let applied = 0;
      await editor.edit((editBuilder) => {
        for (const e of edits) {
          if (e.range.start.line >= doc.lineCount) continue;
          const actualEndLine = Math.min(e.range.end.line, doc.lineCount);
          const actualRange = new vscode.Range(e.range.start.line, 0, actualEndLine, 0);
          editBuilder.replace(actualRange, e.newText);
          applied++;
        }
      });

      if (applied > 0) {
        vscode.window.showInformationMessage(`${applied} hunk(s) applied successfully.`);
      } else {
        vscode.window.showWarningMessage('Could not parse diff or no valid hunks.');
      }
    });
  }
}
