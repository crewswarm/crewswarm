import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface FileOperation {
  path: string;
  contents: string;
  operation: 'create' | 'update' | 'delete';
}

export class DiffHandler {
  async applyToActive(diff: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor to apply diff.');
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      'Apply diff to active file?',
      'Preview',
      'Apply',
      'Cancel'
    );

    if (choice === 'Cancel') return;

    try {
      const edits = this.parseUnifiedDiff(diff);
      if (edits.length === 0) {
        vscode.window.showWarningMessage('Could not parse diff or no valid hunks.');
        return;
      }

      if (choice === 'Preview') {
        await this.showPreview(editor.document, edits);
        return;
      }

      await this.applyEdits(editor, edits);
      vscode.window.showInformationMessage(`${edits.length} hunk(s) applied successfully.`);
    } catch (error: unknown) {
      vscode.window.showErrorMessage(`Failed to apply diff: ${(error as Error).message}`);
    }
  }

  async applyFile(file: { path: string; contents: string }): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    const fullPath = path.join(workspaceFolder.uri.fsPath, file.path);
    const dir = path.dirname(fullPath);
    const exists = fs.existsSync(fullPath);

    try {
      // Create directory if it doesn't exist
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const choice = await vscode.window.showInformationMessage(
        `${exists ? 'Update' : 'Create'} file "${file.path}"?`,
        'Preview',
        exists ? 'Update' : 'Create',
        'Cancel'
      );

      if (choice === 'Cancel') return;

      if (choice === 'Preview') {
        await this.showFilePreview(file.path, file.contents);
        return;
      }

      fs.writeFileSync(fullPath, file.contents);
      vscode.window.showInformationMessage(`File "${file.path}" ${exists ? 'updated' : 'created'} successfully.`);

      // Open the file in editor
      const document = await vscode.workspace.openTextDocument(fullPath);
      await vscode.window.showTextDocument(document);
    } catch (error: unknown) {
      vscode.window.showErrorMessage(`Failed to ${exists ? 'update' : 'create'} file: ${(error as Error).message}`);
    }
  }

  private parseUnifiedDiff(diff: string): Array<{ range: vscode.Range; newText: string }> {
    const edits: Array<{ range: vscode.Range; newText: string }> = [];
    const lines = diff.split('\n');
    
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
    
    return edits;
  }

  private async applyEdits(editor: vscode.TextEditor, edits: Array<{ range: vscode.Range; newText: string }>): Promise<void> {
    const doc = editor.document;
    await editor.edit((editBuilder) => {
      for (const edit of edits) {
        if (edit.range.start.line >= doc.lineCount) continue;
        const actualEndLine = Math.min(edit.range.end.line, doc.lineCount);
        const actualRange = new vscode.Range(edit.range.start.line, 0, actualEndLine, 0);
        editBuilder.replace(actualRange, edit.newText);
      }
    });
  }

  private async showPreview(document: vscode.TextDocument, edits: Array<{ range: vscode.Range; newText: string }>): Promise<void> {
    const uri = document.uri;
    const previewContent = this.generatePreviewContent(document, edits);
    
    // Create a temporary document for preview
    const previewUri = vscode.Uri.parse(`untitled:${document.fileName}.preview`);
    const doc = await vscode.workspace.openTextDocument(previewUri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    
    await editor.edit((editBuilder) => {
      const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
      editBuilder.replace(fullRange, previewContent);
    });
    
    vscode.window.showInformationMessage('Preview mode - close this tab to cancel, or apply the diff from the original file.');
  }

  private generatePreviewContent(document: vscode.TextDocument, edits: Array<{ range: vscode.Range; newText: string }>): string {
    // Simple preview generation - in a real implementation, this would be more sophisticated
    const lines = document.getText().split('\n');
    let result = lines.slice();
    
    // Apply edits in reverse order to maintain line numbers
    for (const edit of edits.reverse()) {
      const startLine = edit.range.start.line;
      const endLine = edit.range.end.line;
      const newLines = edit.newText.split('\n');
      
      result.splice(startLine, endLine - startLine, ...newLines);
    }
    
    return result.join('\n');
  }

  private async showFilePreview(filePath: string, contents: string): Promise<void> {
    const previewUri = vscode.Uri.parse(`untitled:${filePath}.preview`);
    const doc = await vscode.workspace.openTextDocument(previewUri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    
    await editor.edit((editBuilder) => {
      const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
      editBuilder.replace(fullRange, contents);
    });
    
    vscode.window.showInformationMessage('Preview mode - close this tab to cancel, or create/update the file.');
  }
}