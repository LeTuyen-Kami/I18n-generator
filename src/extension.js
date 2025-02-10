const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const I18nSidebarProvider = require('./I18nSidebarProvider');

class I18nTreeDataProvider {
  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    return [];
  }
}

function activate(context) {
    console.log("Extension activated!");

    try {
        // Register Tree Data Provider
        const treeDataProvider = new I18nTreeDataProvider();
        context.subscriptions.push(
            vscode.window.registerTreeDataProvider('i18nExplorer', treeDataProvider)
        );

        // Register Webview Provider
        const sidebarProvider = new I18nSidebarProvider(context.extensionUri);
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider("i18n-sidebar", sidebarProvider)
        );
    } catch (error) {
        console.error("Error activating extension:", error);
    }
}

exports.activate = activate;
function deactivate() {}
exports.deactivate = deactivate;