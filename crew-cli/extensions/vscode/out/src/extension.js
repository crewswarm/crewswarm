"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const api_client_1 = require("./api-client");
const diff_handler_1 = require("./diff-handler");
function activate(context) {
    const apiClient = new api_client_1.ApiClient();
    const diffHandler = new diff_handler_1.DiffHandler();
    const disposable = vscode.commands.registerCommand('crewswarm.openChat', async () => {
        const webviewDir = vscode.Uri.file(path.join(context.extensionPath, 'src', 'webview'));
        const panel = vscode.window.createWebviewPanel('crewswarmChat', 'CrewSwarm Chat', vscode.ViewColumn.One, {
            enableScripts: true,
            localResourceRoots: [webviewDir]
        });
        const htmlPath = path.join(context.extensionPath, 'src', 'webview', 'chat.html');
        let html = fs.readFileSync(htmlPath, 'utf-8');
        const stylesUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'src', 'webview', 'styles.css')));
        const scriptUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'src', 'webview', 'chat.js')));
        html = html.replace('${styles}', stylesUri.toString());
        html = html.replace('${script}', scriptUri.toString());
        panel.webview.html = html;
        panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'sendMessage':
                    try {
                        const response = await apiClient.chat(message.text);
                        panel.webview.postMessage({ command: 'addResponse', response });
                    }
                    catch (error) {
                        panel.webview.postMessage({ command: 'addResponse', response: 'Error: ' + error });
                    }
                    break;
                case 'applyDiff':
                    diffHandler.applyToActive(message.diff);
                    break;
            }
        }, undefined, context.subscriptions);
    });
    context.subscriptions.push(disposable);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map