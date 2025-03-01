/*
*  This file is based on the work made by DominicVonk at https://github.com/DominicVonk/vscode-variables
*  This has been imported and updated to allow using the latest @types/vscode library
*/
import * as vscode from 'vscode';
import * as process from 'process';
import * as path from 'path';
import { homedir } from 'os';

/**
 * It substitutes variables that use the syntax ${variableName} and belong to the list below, within the value.
 * If recursive is true, the function is called recursively if another variable is found after the first call.
 * E.g "${userHome}/my_custom_kubectl_folder/kubectl" -> "home_path/my_custom_kubectl_folder/kubectl"
 *
 * The following predefined variables are supported:
 *      ${userHome} - the path of the user's home folder
 *      ${workspaceFolder} - the path of the folder opened in VS Code
 *      ${workspaceFolderBasename} - the name of the folder opened in VS Code without any slashes (/)
 *      ${file} - the current opened file
 *      ${fileWorkspaceFolder} - the current opened file's workspace folder
 *      ${relativeFile} - the current opened file relative to workspaceFolder
 *      ${relativeFileDirname} - the current opened file's dirname relative to workspaceFolder
 *      ${fileBasename} - the current opened file's basename
 *      ${fileBasenameNoExtension} - the current opened file's basename with no file extension
 *      ${fileExtname} - the current opened file's extension
 *      ${fileDirname} - the current opened file's folder path
 *      ${cwd} - the task runner's current working directory upon the startup of VS Code
 *      ${lineNumber} - the current selected line number in the active file
 *      ${selectedText} - the current selected text in the active file
 *      ${pathSeparator} - the character used by the operating system to separate components in file paths
 */
export function interpolateVariables(value: string | undefined, recursive = false): string | undefined {
    if (!value) {
        return value;
    }

    if (typeof value !== 'string') {
        return undefined;
    }

    const workspaces = vscode.workspace.workspaceFolders;
    const workspace = workspaces ? workspaces[0] : undefined;
    const activeFile = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document : undefined; // TODO: upgrade TypeScript so we can use ?.
    const absoluteFilePath = activeFile ? activeFile.uri ? activeFile.uri.fsPath : undefined : undefined;  // TODO: upgrade TypeScript so we can use ?.

    value = value.replace(/\${userHome}/g, homedir());

    if (workspace) {
        value = value.replace(/\${workspaceFolder}/g, workspace.uri.fsPath);
        value = value.replace(/\${workspaceFolderBasename}/g, workspace.name);
    }

    let fileWorkspace = workspace;
    let relativeFilePath = absoluteFilePath;
    if (workspaces) {
        for (const innerWorkspace of workspaces) {
            if (absoluteFilePath && absoluteFilePath.replace(innerWorkspace.uri.fsPath, '') !== absoluteFilePath) {
                fileWorkspace = innerWorkspace;
                relativeFilePath = absoluteFilePath.replace(innerWorkspace.uri.fsPath, '').substring(path.sep.length);
                break;
            }
        }
    }

    if (fileWorkspace) {
        value = value.replace(/\${fileWorkspaceFolder}/g, fileWorkspace.uri.fsPath);
    }

    if (relativeFilePath) {
        value = value.replace(/\${relativeFile}/g, relativeFilePath);
        value = value.replace(/\${relativeFileDirname}/g, relativeFilePath.substring(0, relativeFilePath.lastIndexOf(path.sep)));
        value = value.replace(/\${fileBasename}/g, path.basename(relativeFilePath));
        value = value.replace(/\${fileBasenameNoExtension}/g, path.basename(relativeFilePath, path.extname(relativeFilePath)));
        value = value.replace(/\${fileExtname}/g, path.extname(relativeFilePath));
        value = value.replace(/\${fileDirname}/g, path.dirname(absoluteFilePath!));
    }

    if (absoluteFilePath) {
        value = value.replace(/\${file}/g, absoluteFilePath);
    }

    value = value.replace(/\${cwd}/g, process.cwd());

    const activeEditor = vscode.window.activeTextEditor;    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        const selection = activeEditor.selection; = activeEditor.selection;
        const selectedText = activeEditor.document.getText(selection);
        value = value.replace(/\${lineNumber}/g, (selection.active.line + 1).toString());
        value = value.replace(/\${selectedText}/g, selectedText);   value = value.replace(/\${selectedText}/g, selectedText);
    }

    value = value.replace(/\${pathSeparator}/g, path.sep);/g, path.sep);

    value = value.replace(/\${env:(.*?)}/g, function (variable) { = value.replace(/\${env:(.*?)}/g, function (variable) {
        const matches = variable.match(/\${env:(.*?)}/);hes = variable.match(/\${env:(.*?)}/);
        if (matches && matches.length > 1) { if (matches && matches.length > 1) {
            return process.env[matches[1]] || '';
        }
        return '';
    });
    value = value.replace(/\${config:(.*?)}/g, function (variable) { = value.replace(/\${config:(.*?)}/g, function (variable) {
        const matches = variable.match(/\${env:(.*?)}/);hes = variable.match(/\${env:(.*?)}/);
        if (matches && matches.length > 1) { if (matches && matches.length > 1) {
            return vscode.workspace.getConfiguration().get(matches[1], '');            return vscode.workspace.getConfiguration().get(matches[1], '');
        }
        return '';
    }););

    if (recursive) {   if (recursive) {
        const newValue = interpolateVariables(value, true);        const newValue = interpolateVariables(value, true);








}    return value;    }        }            value = newValue;        if (newValue !== value) {        if (newValue !== value) {
            value = newValue;
        }
    }

    return value;
}
