"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiffHandler = void 0;
const vscode = __importStar(require("vscode"));
class DiffHandler {
    applyToActive(diff) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor to apply diff.');
            return;
        }
        vscode.window.showInformationMessage('Applying diff to active file...', 'Apply', 'Cancel').then(async (choice) => {
            if (choice === 'Cancel')
                return;
            // Improved unified diff parser for multiple hunks
            const lines = diff.split('\n');
            const edits = [];
            let i = 0;
            while (i < lines.length) {
                const line = lines[i];
                if (line.startsWith('@@')) {
                    const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
                    if (match) {
                        const oldStart = parseInt(match[1]) - 1;
                        const oldCount = match[2] ? parseInt(match[2]) : 1;
                        const hunkNewLines = [];
                        i++; // move to next line after @@
                        while (i < lines.length && !lines[i].startsWith('@@')) {
                            const l = lines[i];
                            if (l.startsWith('\\ No newline')) {
                                // skip
                            }
                            else if (!l.startsWith('-')) {
                                if (l.startsWith('+')) {
                                    hunkNewLines.push(l.slice(1));
                                }
                                else {
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
                    if (e.range.start.line >= doc.lineCount)
                        continue;
                    const actualEndLine = Math.min(e.range.end.line, doc.lineCount);
                    const actualRange = new vscode.Range(e.range.start.line, 0, actualEndLine, 0);
                    editBuilder.replace(actualRange, e.newText);
                    applied++;
                }
            });
            if (applied > 0) {
                vscode.window.showInformationMessage(`${applied} hunk(s) applied successfully.`);
            }
            else {
                vscode.window.showWarningMessage('Could not parse diff or no valid hunks.');
            }
        });
    }
}
exports.DiffHandler = DiffHandler;
//# sourceMappingURL=diff-handler.js.map