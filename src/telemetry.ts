import TelemetryReporter from '@vscode/extension-telemetry';
import * as vscode from 'vscode';

export let reporter: TelemetryReporter | undefined;

export class Reporter extends vscode.Disposable {

    constructor(ctx: vscode.ExtensionContext) {
        super(() => { if (reporter) { reporter.dispose(); } });
        const packageInfo = getPackageInfo(ctx);
        reporter = packageInfo && new TelemetryReporter(packageInfo.name, packageInfo.version, packageInfo.aiKey);

    }
}

interface IPackageInfo {
    name: string;
    version: string;
    aiKey: string;
}

function getPackageInfo(_context: vscode.ExtensionContext): IPackageInfo | undefined {
    const extensionPackage = require('../package');
    if (extensionPackage) {
        return {
            name: extensionPackage.name,
            version: extensionPackage.version,
            aiKey: extensionPackage.aiKey
        };
    }
    return undefined;
}

export function sendTelemetryEvent(eventName: string, properties?: { [key: string]: string }, measurements?: { [key: string]: number }) {
    const telemetryReporter = vscode.extensions.getExtension('your-extension-id')?.exports?.telemetryReporter;
    if (telemetryReporter) {
        telemetryReporter.sendTelemetryEvent(eventName, properties, measurements);
    }
}
