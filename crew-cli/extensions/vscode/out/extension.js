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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
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