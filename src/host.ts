import * as vscode from 'vscode';
import { shellEnvironment } from './shell';
import { showWorkspaceFolderPick } from './hostutils';
import { Dictionary } from './utils/dictionary';

export interface Host {
    showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
    showWarningMessage(message: string, ...items: string[]): Promise<string | undefined>;
    showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>;
    showInputBox(options: vscode.InputBoxOptions, token?: vscode.CancellationToken): Promise<string | undefined>;
    showQuickPick(items: string[], options: vscode.QuickPickOptions): Promise<string | undefined>;
    showQuickPick<T extends vscode.QuickPickItem>(items: T[], options: vscode.QuickPickOptions): Promise<T | undefined>;
    withProgress<R>(task: (progress: vscode.Progress<{ message?: string }>) => Promise<R>): Promise<R>;
    getConfiguration(key: string): any;
    createTerminal(name?: string, shellPath?: string, shellArgs?: string[]): vscode.Terminal;
    onDidCloseTerminal(listener: (e: vscode.Terminal) => any): vscode.Disposable;
    onDidChangeConfiguration(listener: (ch: vscode.ConfigurationChangeEvent) => any): vscode.Disposable;
    activeDocument(): vscode.TextDocument | undefined;
    showDocument(uri: vscode.Uri): Promise<vscode.TextDocument>;
    readDocument(uri: vscode.Uri): Promise<vscode.TextDocument>;
    selectRootFolder(): Promise<string | undefined>;
    longRunning<T>(uiOptions: string | LongRunningUIOptions, action: () => Promise<T>): Promise<T>;
}

export class VSCodeHost implements Host {lements Host {
    showErrorMessage(message: string, ...items: string[]): Promise<string | undefined> {.items: string[]): Promise<string | undefined> {
        return vscode.window.showErrorMessage(message, ...items);e(message, ...items);
    }

    showWarningMessage(message: string, ...items: string[]): Promise<string | undefined> { string, ...items: string[]): Promise<string | undefined> {
        return vscode.window.showWarningMessage(message, ...items);Message(message, ...items);
    }

    showInformationMessage(message: string, ...items: string[]): Promise<string | undefined> {ring[]): Promise<string | undefined> {
        return vscode.window.showInformationMessage(message, ...items);wInformationMessage(message, ...items);
    }

    showInputBox(options: vscode.InputBoxOptions, token?: vscode.CancellationToken): Promise<string | undefined> {.InputBoxOptions, token?: vscode.CancellationToken): Promise<string | undefined> {
        return vscode.window.showInputBox(options, token);x(options, token);
    }

    showQuickPick(items: string[], options: vscode.QuickPickOptions): Promise<string | undefined> {    showQuickPick(items: string[], options: vscode.QuickPickOptions): Promise<string | undefined> {
        return vscode.window.showQuickPick(items, options);ick(items, options);
    }

    showQuickPick<T extends vscode.QuickPickItem>(items: T[], options: vscode.QuickPickOptions): Promise<T | undefined> {   showQuickPick<T extends vscode.QuickPickItem>(items: T[], options: vscode.QuickPickOptions): Promise<T | undefined> {
        return vscode.window.showQuickPick(items, options);        return vscode.window.showQuickPick(items, options);
    }

    withProgress<R>(task: (progress: vscode.Progress<{ message?: string }>) => Promise<R>): Promise<R> {   withProgress<R>(task: (progress: vscode.Progress<{ message?: string }>) => Promise<R>): Promise<R> {
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Window }, task);        return vscode.window.withProgress({ location: vscode.ProgressLocation.Window }, task);
    }

    getConfiguration(key: string): any {   getConfiguration(key: string): any {
        return vscode.workspace.getConfiguration().get(key);        return vscode.workspace.getConfiguration().get(key);
    }

    createTerminal(name?: string, shellPath?: string, shellArgs?: string[]): vscode.Terminal {   createTerminal(name?: string, shellPath?: string, shellArgs?: string[]): vscode.Terminal {
        return vscode.window.createTerminal({ name, shellPath, shellArgs });        return vscode.window.createTerminal({ name, shellPath, shellArgs });
    }

    onDidCloseTerminal(listener: (e: vscode.Terminal) => any): vscode.Disposable {   onDidCloseTerminal(listener: (e: vscode.Terminal) => any): vscode.Disposable {
        return vscode.window.onDidCloseTerminal(listener);        return vscode.window.onDidCloseTerminal(listener);
    }

    onDidChangeConfiguration(listener: (e: vscode.ConfigurationChangeEvent) => any): vscode.Disposable {
        return vscode.workspace.onDidChangeConfiguration(listener);export const host: Host = {
    }

    activeDocument(): vscode.TextDocument | undefined {   showInformationMessage : showInformationMessage,
        const activeEditor = vscode.window.activeTextEditor;    showQuickPick : showQuickPickAny,
        if (activeEditor) {
            return activeEditor.document;uration,
        }
        return undefined;nDidCloseTerminal : onDidCloseTerminal,
    }    onDidChangeConfiguration : onDidChangeConfiguration,
ox,
    async showDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
        const document = await vscode.workspace.openTextDocument(uri);howDocument : showDocument,
        if (document) {    readDocument : readDocument,
            await vscode.window.showTextDocument(document);ectRootFolder,
        }
        return document;
    }

    async readDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {eadonly title: string;
        return await vscode.workspace.openTextDocument(uri);   readonly operationKey?: string;
    }}

    async selectRootFolder(): Promise<string | undefined> { | undefined> {
        const folder = await showWorkspaceFolderPick();   return vscode.window.showInputBox(options, token) as Promise<string | undefined>;
        if (!folder) {}
            return undefined;
        }s: string[]): Promise<string | undefined> {
        if (folder.uri.scheme !== 'file') {   return vscode.window.showErrorMessage(message, ...items) as Promise<string | undefined>;
            vscode.window.showErrorMessage("This command requires a filesystem folder");  // TODO: make it not}
            return undefined;
        }essage: string, ...items: string[]): Promise<string | undefined> {
        return folder.uri.fsPath;indow.showWarningMessage(message, ...items) as Promise<string | undefined> ;
    }

    async longRunning<T>(uiOptions: string | LongRunningUIOptions, action: () => Promise<T>): Promise<T> {tring, ...items: string[]): Promise<string | undefined> {
        const uiOptionsObj = uiOptionsObjectOf(uiOptions);turn vscode.window.showInformationMessage(message, ...items) as Promise<string | undefined>;
        const options = {
            location: vscode.ProgressLocation.Notification,
            title: uiOptionsObj.titlefunction showQuickPickStr(items: string[], options?: vscode.QuickPickOptions): Promise<string | undefined> {
        };
        return await underLongRunningOperationKeyGuard(uiOptionsObj.operationKey, async (alreadyShowingUI) =>
            alreadyShowingUI ?
                await action() :function showQuickPickT<T extends vscode.QuickPickItem>(items: T[], options?: vscode.QuickPickOptions): Promise<T | undefined> {
                await vscode.window.withProgress(options, (_) => action())
        );
    }
}function showQuickPickAny(items: any, options: vscode.QuickPickOptions): any {

export const host: Host = new VSCodeHost();

export interface LongRunningUIOptions {
    readonly title: string;f (items.length === 0) {
    readonly operationKey?: string;ickPickStr(items, options);
}   }

function showInputBox(options: vscode.InputBoxOptions, token?: vscode.CancellationToken): Promise<string | undefined> {
    return vscode.window.showInputBox(options, token) as Promise<string | undefined>;
}QuickPickStr(items, options);

function showErrorMessage(message: string, ...items: string[]): Promise<string | undefined> {   return showQuickPickT(items, options);
    return vscode.window.showErrorMessage(message, ...items) as Promise<string | undefined>;
}

function showWarningMessage(message: string, ...items: string[]): Promise<string | undefined> { }>) => Promise<R>): Promise<R> {
    return vscode.window.showWarningMessage(message, ...items) as Promise<string | undefined> ;.ProgressLocation.Window }, task) as Promise<R>;
}

function showInformationMessage(message: string, ...items: string[]): Promise<string | undefined> {
    return vscode.window.showInformationMessage(message, ...items) as Promise<string | undefined>;
}

function showQuickPickStr(items: string[], options?: vscode.QuickPickOptions): Promise<string | undefined> {ion createTerminal(name?: string, shellPath?: string, shellArgs?: string[]): vscode.Terminal {
    return vscode.window.showQuickPick(items, options) as Promise<string | undefined>;
}
ath,
function showQuickPickT<T extends vscode.QuickPickItem>(items: T[], options?: vscode.QuickPickOptions): Promise<T | undefined> {   shellArgs: shellArgs,
    return vscode.window.showQuickPick(items, options) as Promise<T | undefined>;(process.env)
}   };
    return vscode.window.createTerminal(terminalOptions);
function showQuickPickAny(items: any, options: vscode.QuickPickOptions): any {
    if (!Array.isArray(items)) {
        throw 'unexpected type passed to showQuickPick';
    }

    if (items.length === 0) {
        return showQuickPickStr(items, options);(listener: (e: vscode.ConfigurationChangeEvent) => any): vscode.Disposable {
    }turn vscode.workspace.onDidChangeConfiguration(listener);

    const item = items[0];
    if (typeof item === 'string' || item instanceof String) {scode.TextDocument | undefined {
        return showQuickPickStr(items, options);
    } else { (activeEditor) {
        return showQuickPickT(items, options);       return activeEditor.document;
    }    }
}

function withProgress<R>(task: (progress: vscode.Progress<{ message?: string }>) => Promise<R>): Promise<R> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Window }, task) as Promise<R>;.TextDocument> {
}onst document = await vscode.workspace.openTextDocument(uri);
ocument) {
function getConfiguration(key: string): any {;
    return vscode.workspace.getConfiguration(key);
}ment;

function createTerminal(name?: string, shellPath?: string, shellArgs?: string[]): vscode.Terminal {
    const terminalOptions = {ction readDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
        name: name,eturn await vscode.workspace.openTextDocument(uri);
        shellPath: shellPath,
        shellArgs: shellArgs,
        env: shellEnvironment(process.env)
    };Pick();
    return vscode.window.createTerminal(terminalOptions);
}   return undefined;

function onDidCloseTerminal(listener: (e: vscode.Terminal) => any): vscode.Disposable {   if (folder.uri.scheme !== 'file') {
    return vscode.window.onDidCloseTerminal(listener);        vscode.window.showErrorMessage("This command requires a filesystem folder");  // TODO: make it not
}

function onDidChangeConfiguration(listener: (e: vscode.ConfigurationChangeEvent) => any): vscode.Disposable {   return folder.uri.fsPath;
    return vscode.workspace.onDidChangeConfiguration(listener);}











































































}    return !!((obj as LongRunningUIOptions).title);function isLongRunningUIOptions(obj: string | LongRunningUIOptions): obj is LongRunningUIOptions {}    return { title: uiOptions };    }        return uiOptions;    if (isLongRunningUIOptions(uiOptions)) {function uiOptionsObjectOf(uiOptions: string | LongRunningUIOptions): LongRunningUIOptions {}    }        }            delete ACTIVE_LONG_RUNNING_OPERATIONS[operationKey];        if (operationKey) {    } finally {        return result;        const result = await action(alreadyShowingUI);    try {    }        ACTIVE_LONG_RUNNING_OPERATIONS[operationKey] = true;    if (operationKey) {    const alreadyShowingUI = !!operationKey && (ACTIVE_LONG_RUNNING_OPERATIONS[operationKey] || false);async function underLongRunningOperationKeyGuard<T>(operationKey: string | undefined, action: (alreadyShowingUI: boolean) => Promise<T>): Promise<T> {}    );            await vscode.window.withProgress(options, (_) => action())            await action() :        alreadyShowingUI ?    return await underLongRunningOperationKeyGuard(uiOptionsObj.operationKey, async (alreadyShowingUI) =>    };        title: uiOptionsObj.title        location: vscode.ProgressLocation.Notification,    const options = {    const uiOptionsObj = uiOptionsObjectOf(uiOptions);async function longRunning<T>(uiOptions: string | LongRunningUIOptions, action: () => Promise<T>): Promise<T> {const ACTIVE_LONG_RUNNING_OPERATIONS = Dictionary.of<boolean>();}    return folder.uri.fsPath;    }        return undefined;        vscode.window.showErrorMessage("This command requires a filesystem folder");  // TODO: make it not    if (folder.uri.scheme !== 'file') {    }        return undefined;    if (!folder) {    const folder = await showWorkspaceFolderPick();async function selectRootFolder(): Promise<string | undefined> {}    return await vscode.workspace.openTextDocument(uri);async function readDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {}    return document;    }        await vscode.window.showTextDocument(document);    if (document) {    const document = await vscode.workspace.openTextDocument(uri);async function showDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {}    return undefined;    }        return activeEditor.document;    if (activeEditor) {    const activeEditor = vscode.window.activeTextEditor;function activeDocument(): vscode.TextDocument | undefined {}
const ACTIVE_LONG_RUNNING_OPERATIONS = Dictionary.of<boolean>();

async function longRunning<T>(uiOptions: string | LongRunningUIOptions, action: () => Promise<T>): Promise<T> {
    const uiOptionsObj = uiOptionsObjectOf(uiOptions);
    const options = {
        location: vscode.ProgressLocation.Notification,
        title: uiOptionsObj.title
    };
    return await underLongRunningOperationKeyGuard(uiOptionsObj.operationKey, async (alreadyShowingUI) =>
        alreadyShowingUI ?
            await action() :
            await vscode.window.withProgress(options, (_) => action())
    );
}

async function underLongRunningOperationKeyGuard<T>(operationKey: string | undefined, action: (alreadyShowingUI: boolean) => Promise<T>): Promise<T> {
    const alreadyShowingUI = !!operationKey && (ACTIVE_LONG_RUNNING_OPERATIONS[operationKey] || false);
    if (operationKey) {
        ACTIVE_LONG_RUNNING_OPERATIONS[operationKey] = true;
    }
    try {
        const result = await action(alreadyShowingUI);
        return result;
    } finally {
        if (operationKey) {
            delete ACTIVE_LONG_RUNNING_OPERATIONS[operationKey];
        }
    }
}

function uiOptionsObjectOf(uiOptions: string | LongRunningUIOptions): LongRunningUIOptions {
    if (isLongRunningUIOptions(uiOptions)) {
        return uiOptions;
    }
    return { title: uiOptions };
}

function isLongRunningUIOptions(obj: string | LongRunningUIOptions): obj is LongRunningUIOptions {
    return !!((obj as LongRunningUIOptions).title);
}
