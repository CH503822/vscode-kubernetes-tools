import * as vscode from 'vscode';

export async function showWorkspaceFolderPick(): Promise<vscode.WorkspaceFolder | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined;
    }
    if (workspaceFolders.length === 1) {
        return workspaceFolders[0];
    }
    return await vscode.window.showWorkspaceFolderPick();
}
