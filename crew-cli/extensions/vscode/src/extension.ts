import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ApiClient } from './api-client';
import { DiffHandler } from './diff-handler';

export function activate(context: vscode.ExtensionContext) {
  const apiClient = new ApiClient();
  const diffHandler = new DiffHandler();
  
  // Set up status bar item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(sync~spin) crewswarm";
  statusBarItem.tooltip = "crewswarm AI Assistant";
  statusBarItem.command = "crewswarm.openChat";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  
  // Test connection and update status
  apiClient.chat('test').then((response) => {
    statusBarItem.text = "$(check) crewswarm";
  }).catch(() => {
    statusBarItem.text = "$(error) crewswarm";
  });

  const disposable = vscode.commands.registerCommand('crewswarm.openChat', async () => {
    const webviewDir = vscode.Uri.file(path.join(context.extensionPath, 'src', 'webview'));
    const panel = vscode.window.createWebviewPanel(
      'crewswarmChat',
      'crewswarm Chat',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [webviewDir]
      }
    );

    const htmlPath = path.join(context.extensionPath, 'src', 'webview', 'chat.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');

    const stylesUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'src', 'webview', 'styles.css')));
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'src', 'webview', 'chat.js')));

    html = html.replace('${styles}', stylesUri.toString());
    html = html.replace('${script}', scriptUri.toString());

    panel.webview.html = html;

    panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'sendMessage':
            try {
              const response = await apiClient.chat(message.text);
              // Handle structured response format from PDD
              if (response.reply || response.patches || response.files) {
                panel.webview.postMessage({ command: 'addResponse', response: response });
              } else {
                // Fallback for simple responses
                panel.webview.postMessage({ command: 'addResponse', response: response.reply || 'No response' });
              }
            } catch (error) {
              panel.webview.postMessage({ command: 'addResponse', response: 'Error: ' + error });
            }
            break;
          case 'applyDiff':
            diffHandler.applyToActive(message.diff);
            break;
        }
      },
      undefined,
      context.subscriptions
    );
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}