import * as _ from 'lodash';
import * as filepath from 'path';
import * as tmp from 'tmp';
import * as vscode from 'vscode';
import * as YAML from 'js-yaml';
import { Context, ExecResult, ExternalBinary, invokeForResult } from './binutilplusplus';
import { NODE_TYPES } from './components/clusterexplorer/explorer';
import { ClusterExplorerHelmReleaseNode, ClusterExplorerNode } from './components/clusterexplorer/node';
import { HelmHistoryNode, HelmReleaseNode } from './components/clusterexplorer/node.helmrelease';
import { refreshExplorer } from './components/clusterprovider/common/explorer';
import { getToolPath } from './components/config/config';
import { installDependencies } from './components/installer/installdependencies';
import { Errorable, failed } from './errorable';
import { fs as shellfs } from './fs';
import * as helm from './helm';
import * as helmrepoexplorer from './helm.repoExplorer';
import { host, LongRunningUIOptions } from './host';
import { showWorkspaceFolderPick } from './hostutils';
import { Kubectl } from './kubectl';
import { currentNamespace } from './kubectlUtils';
import { HELM_RESOURCE_AUTHORITY, K8S_RESOURCE_SCHEME } from './kuberesources.virtualfs';
import { helm as logger } from './logger';
import { parseLineOutput } from './outputUtils';
import { ExecCallback, shell as sh, ShellResult } from './shell';
import { openHelmGeneratedValuesFile, preview } from './utils/preview';
import * as fs from './wsl-fs';
import * as shell from './shell';
import { writeFileSync, readFileSync } from 'fs';
import * as kubectlUtils from './kubectlUtils';

export interface PickChartUIOptions {
    readonly warnIfNoCharts: boolean;
}

export enum EnsureMode {
    Alert,
    Silent,
}

// Schema for repositories.yaml
interface HelmRepositoriesFile {
    readonly repositories: ReadonlyArray<{
        readonly name: string;
        readonly cache: string;  // cache file path
        readonly url: string;
    }>;
}

// Schema for Helm release
// added to support rollback feature
export interface HelmRelease {
    readonly revision: number;
    readonly updated: string;
    readonly status: string;
    readonly chart: string;
    readonly appVersion: string;
    readonly description: string;
}

function helmReleaseFromJSON(json: any): HelmRelease {
    return { appVersion: json.app_version, ...json };
}

// This file contains utilities for executing command line tools, notably Helm.
const helmRepoExplorer = new helmrepoexplorer.HelmRepoExplorer(host);

export async function helmVersion() {
    const syntaxVersion = await helmSyntaxVersion();
    const versionArgs = (syntaxVersion === HelmSyntaxVersion.V3) ? '' : '-c';
    const sr = await helmExecAsync(`version ${versionArgs}`);
    if (!sr) {
        vscode.window.showErrorMessage('Failed to run Helm');
        return;
    }
    if (sr.code !== 0) {
        vscode.window.showErrorMessage(sr.stderr);
        return;
    }
    vscode.window.showInformationMessage(sr.stdout);
}

export enum HelmSyntaxVersion {
    Unknown = 1,
    V2 = 2,
    V3 = 3,
}

let cachedVersion: HelmSyntaxVersion | undefined = undefined;

export async function helmSyntaxVersion(): Promise<HelmSyntaxVersion> {
    if (cachedVersion === undefined) {
        const srHelm2 = await helmExecAsync(`version --short -c`);
        if (!srHelm2) {
            // failed to run Helm; do not cache result
            return HelmSyntaxVersion.Unknown;
        }

        if (srHelm2.code === 0 && srHelm2.stdout.indexOf('v2') >= 0) {
            cachedVersion = HelmSyntaxVersion.V2;
        } else {
            const srHelm3 = await helmExecAsync(`version --short`);
            if (srHelm3 && srHelm3.code === 0 && srHelm3.stdout.indexOf('v3') >= 0) {
                cachedVersion = HelmSyntaxVersion.V3;
            } else {
                return HelmSyntaxVersion.Unknown;
            }
        }
    }
    return cachedVersion;
}

// Run a 'helm template' command.
// This looks for Chart.yaml files in the present project. If only one is found, it
// runs 'helm template' on it. If multiples are found, it prompts the user to select one.
export function helmTemplate() {
    pickChart((path) => {
        helmExec(`template "${path}"`, (code, out, err) => {
            if (code !== 0) {
                vscode.window.showErrorMessage(err);
                return;
            }
            vscode.window.showInformationMessage("chart rendered successfully");
            logger.log(out);
        });
    });
}

export function helmTemplatePreview() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage("No active editor.");
        return;
    }

    const filePath = editor.document.fileName;
    if (filePath.indexOf("templates") < 0) {
        vscode.window.showInformationMessage("Not a template: " + filePath);
        return;
    }

    if (!ensureHelm(EnsureMode.Alert)) {
        return;
    }

    const u = vscode.Uri.parse(helm.PREVIEW_URI);
    const f = filepath.basename(filePath);
    preview(u, vscode.ViewColumn.Two, `Preview ${f}`);
    helm.recordPreviewHasBeenShown();
}

export function helmDepUp(arg: any /* Uri | TextDocument | undefined */) {
    if (!arg) {
        pickChart((path) => helmDepUpCore(path));
        return;
    }

    const uri: vscode.Uri = arg.uri || arg;

    if (uri.scheme !== 'file') {
        vscode.window.showErrorMessage('Chart is not on the filesystem');
        return;
    }
    const path = filepath.dirname(uri.fsPath);
    helmDepUpCore(path);
}

function helmDepUpCore(path: string) {
    logger.log("⎈⎈⎈ Updating dependencies for " + path);
    helmExec(`dep up "${path}"`, (code, out, err) => {
        logger.log(out);
        logger.log(err);
        if (code !== 0) {
            logger.log("⎈⎈⎈ UPDATE FAILED");
        }
    });
}

export async function helmCreate(): Promise<void> {
    const createResult = await helmCreateCore("Chart name", "mychart");

    if (createResult && failed(createResult)) {
        vscode.window.showErrorMessage(createResult.error[0]);
    }
}

export async function helmCreateCore(prompt: string, sampleName: string): Promise<Errorable<{ name: string; path: string }> | undefined> {
    const folder = await showWorkspaceFolderPick();
    if (!folder) {
        return undefined;
    }

    const name = await vscode.window.showInputBox({
        prompt: prompt,
        placeHolder: sampleName
    });

    if (!name) {
        return undefined;
    }

    const fullpath = filepath.join(folder.uri.fsPath, name);

    const sr = await helmExecAsync(`create "${fullpath}"`);

    if (!sr || sr.code !== 0) {
        return { succeeded: false, error: [sr ? sr.stderr : "Unable to run Helm"] };
    }

    return { succeeded: true, result: { name: name, path: fullpath } };
}

// helmLint runs the Helm linter on a chart within your project.
export function helmLint() {
    pickChart((path) => {
        logger.log("⎈⎈⎈ Linting " + path);
        helmExec(`lint "${path}"`, (code, out, err) => {
            logger.log(out);
            logger.log(err);
            if (code !== 0) {
                logger.log("⎈⎈⎈ LINTING FAILED");
            }
        });
    });
}

export function helmFetchValues(arg: any) {
    helmInspect(arg, {
        noTargetMessage:
            "Helm generate values.yaml is for packaged charts and directories. Launch the command from a file or directory in the file explorer. or a chart or version in the Helm Repos explorer.",
        inspectionScheme: helm.FETCH_VALUES_SCHEME,
        generateFile: true,
    });
}

export function helmInspectChart(arg: any) {
    helmInspect(arg, {
        noTargetMessage: "Helm Inspect Chart is for packaged charts and directories. Launch the command from a chart or version in the Helm Repos explorer.",
        inspectionScheme: helm.INSPECT_CHART_SCHEME,
        generateFile: false
    });
}

interface InspectionStrategy {
    readonly noTargetMessage: string;
    readonly inspectionScheme: string;
    readonly generateFile: boolean;
}

function helmInspect(arg: any, s: InspectionStrategy) {
    if (!arg) {
        vscode.window.showErrorMessage(s.noTargetMessage);
        return;
    }
    if (!ensureHelm(EnsureMode.Alert)) {
        return;
    }

    if (helmrepoexplorer.isHelmRepoChart(arg) || helmrepoexplorer.isHelmRepoChartVersion(arg)) {
        const id = arg.id;
        if (s.generateFile) {
            const versionQuery = helmrepoexplorer.isHelmRepoChartVersion(arg) ? `&version=${arg.version}` : "";
            let valuesFileName = `${id}-values.yaml`;
            if (versionQuery !== "") {
                valuesFileName = `${id}-${versionQuery.replace('&version=', "")}-values.yaml`;
            }
            const uri = vscode.Uri.parse(
                `${s.inspectionScheme}://${helm.INSPECT_REPO_AUTHORITY}/${valuesFileName}?chart=${id}${versionQuery}`
            );
            openHelmGeneratedValuesFile(uri);
        } else {
            const versionQuery = helmrepoexplorer.isHelmRepoChartVersion(arg) ? `?version=${arg.version}` : "";
            const uri = vscode.Uri.parse(`${s.inspectionScheme}://${helm.INSPECT_REPO_AUTHORITY}/${id}${versionQuery}`);
            preview(uri, vscode.ViewColumn.Two, "Inspect");
        }
    } else {
        const u = arg as vscode.Uri;
        const uri = vscode.Uri.parse(`${s.inspectionScheme}://${helm.INSPECT_FILE_AUTHORITY}/?${u.fsPath}`);
        preview(uri, vscode.ViewColumn.Two, "Inspect");
    }
}

// helmDryRun runs a helm install with --dry-run and --debug set.
export function helmDryRun() {
    pickChart(async (path) => {
        const syntaxVersion = await helmSyntaxVersion();
        const generateNameArg = (syntaxVersion === HelmSyntaxVersion.V3) ? '--generate-name' : '';
        logger.log("⎈⎈⎈ Installing (dry-run) " + path);
        helmExec(`install --dry-run ${generateNameArg} --debug "${path}"`, (code, out, err) => {
            logger.log(out);
            logger.log(err);
            if (code !== 0) {
                logger.log("⎈⎈⎈ INSTALL FAILED");
            }
        });
    });
}

export function helmGet(resourceNode?: ClusterExplorerNode) {
    if (!resourceNode) {
        return;
    }
    if (
        resourceNode.nodeType !== NODE_TYPES.helm.history &&
        resourceNode.nodeType !== NODE_TYPES.helm.release
    ) {
        return;
    }
    const releaseName = resourceNode.releaseName;
    const revisionNumber = (resourceNode.nodeType === NODE_TYPES.helm.history ? resourceNode.release.revision : undefined);
    const uri = helmfsUri(releaseName, revisionNumber);
    vscode.workspace.openTextDocument(uri).then((doc) => {
        if (doc) {
            vscode.window.showTextDocument(doc);
        }
    });
}

export function helmUninstall(resourceNode?: ClusterExplorerNode) {
    if (!resourceNode) {
        return;
    }
    if (resourceNode.nodeType !== NODE_TYPES.helm.release) {
        return;
    }
    const releaseName = resourceNode.releaseName;
    logger.log("⎈⎈⎈ Uninstalling " + releaseName);
    vscode.window.showWarningMessage(`You are about to uninstall ${releaseName}. This action cannot be undone.`, { modal: true }, 'Uninstall').then((opt) => {
        if (opt === "Uninstall") {
            helmExec(`del ${releaseName}`, (code, out, err) => {
                logger.log(out);
                logger.log(err);
                if (code !== 0) {
                    logger.log("⎈⎈⎈ UNINSTALL FAILED");
                    vscode.window.showErrorMessage(`Error uninstalling ${releaseName} ${err}`);
                } else {
                    vscode.window.showInformationMessage(`Release ${releaseName} successfully uninstalled.`);
                    refreshExplorer();
                }
            });
        }
    });
}

export async function helmGetHistory(release: string): Promise<Errorable<HelmRelease[]>> {
    if (!ensureHelm(EnsureMode.Alert)) {
        return { succeeded: false, error: ["Helm client is not installed"] };
    }
    const sr = await helmExecAsync(`history ${release} --output json`);
    if (!sr || sr.code !== 0) {
        const message = `Helm fetch history failed: ${sr ? sr.stderr : "Unable to run Helm"}`;
        await vscode.window.showErrorMessage(message);
        return { succeeded: false, error: [message] };
    } else {
        const releasesJSON: any[] = JSON.parse(sr.stdout);
        const releases = releasesJSON.map(helmReleaseFromJSON);
        return { succeeded: true, result: releases.reverse() };
    }
}

export async function helmRollback(resourceNode?: HelmHistoryNode) {
    if (!resourceNode) {
        return;
    }
    if (resourceNode.release.status === "deployed") {
        vscode.window.showInformationMessage('This is the currently deployed release');
        return;
    }
    const releaseName = resourceNode.releaseName;
    const release = resourceNode.release;
    vscode.window.showWarningMessage(`You are about to rollback ${releaseName} to release version ${release.revision}. Continue?`, { modal: true }, 'Rollback').then((opt) => {
        if (opt === "Rollback") {
            helmExec(`rollback ${releaseName} ${release.revision} --cleanup-on-fail`, async (code, out, err) => {
                logger.log(out);
                logger.log(err);
                if (out !== "") {
                    vscode.window.showInformationMessage(`Release ${releaseName} successfully rolled back to ${release.revision}.`);
                    refreshExplorer();
                }
                if (code !== 0) {
                    vscode.window.showErrorMessage(`Error rolling back to ${release.revision} for ${releaseName} ${err}`);
                }
            });
        }
    });
}

export function helmfsUri(releaseName: string, revision: number | undefined): vscode.Uri {
    const revisionSuffix = revision ? `-${revision}` : '';
    const revisionQuery = revision ? `&revision=${revision}` : '';

    const docname = `helmrelease-${releaseName}${revisionSuffix}.yml`;
    const nonce = new Date().getTime();
    const uri = `${K8S_RESOURCE_SCHEME}://${HELM_RESOURCE_AUTHORITY}/${docname}?value=${releaseName}${revisionQuery}&_=${nonce}`;
    return vscode.Uri.parse(uri);
}

// helmPackage runs the Helm package on a chart within your project.
export function helmPackage() {
    pickChart((path) => {
        const options = { openLabel: "Save Package", canSelectFiles: false, canSelectFolders: true, canSelectMany: false };
        vscode.window.showOpenDialog(options).then((packagePath) => {
            if (packagePath && packagePath.length === 1) {
                if (packagePath[0].scheme !== 'file') {
                    vscode.window.showErrorMessage('Packaging folder must be a filesystem folder');
                    return;
                }
                const packageDir = packagePath[0].fsPath;Path;
                helmExec(`package ${path} -d ${packageDir}`, (code, out, err) => {
                    if (code !== 0) {{
                        vscode.window.showErrorMessage(`Error packaging chart: ${err}`);w.showErrorMessage(`Error packaging chart: ${err}`);
                    } else {
                        vscode.window.showInformationMessage(`Chart packaged: ${out}`);(`Chart packaged: ${out}`);
                    }
                });
            }
        });
    });
}

export async function helmFetch(helmObject: helmrepoexplorer.HelmObject | undefined): Promise<void> {export async function helmFetch(helmObject: helmrepoexplorer.HelmObject | undefined): Promise<void> {
    if (!helmObject) {
        const id = await vscode.window.showInputBox({ prompt: "Chart to fetch", placeHolder: "stable/mychart" });it vscode.window.showInputBox({ prompt: "Chart to fetch", placeHolder: "stable/mychart" });
        if (id) {
            helmFetchCore(id, undefined);etchCore(id, undefined);
        }
    }
    if (helmrepoexplorer.isHelmRepoChart(helmObject)) {f (helmrepoexplorer.isHelmRepoChart(helmObject)) {
        await helmFetchCore(helmObject.id, undefined);
    } else if (helmrepoexplorer.isHelmRepoChartVersion(helmObject)) {(helmObject)) {
        await helmFetchCore(helmObject.id, helmObject.version);
    }
}

async function helmFetchCore(chartId: string, version: string | undefined): Promise<void> {async function helmFetchCore(chartId: string, version: string | undefined): Promise<void> {
    if (!shell.isSafe(chartId)) {
        vscode.window.showWarningMessage(`Unexpected characters in chart name ${chartId}. Use Helm CLI to fetch this chart.`);Message(`Unexpected characters in chart name ${chartId}. Use Helm CLI to fetch this chart.`);
        return;
    }
    if (version && !shell.isSafe(version)) {f (version && !shell.isSafe(version)) {
        vscode.window.showWarningMessage(`Unexpected characters in chart version ${version}. Use Helm CLI to fetch this chart.`);expected characters in chart version ${version}. Use Helm CLI to fetch this chart.`);
        return;
    }

    const projectFolder = await showWorkspaceFolderPick();    const projectFolder = await showWorkspaceFolderPick();
    if (!projectFolder) {
        return;
    }

    const versionArg = version ? `--version ${version}` : '';    const versionArg = version ? `--version ${version}` : '';
    const sr = await helmExecAsync(`fetch ${chartId} --untar ${versionArg} -d "${projectFolder.uri.fsPath}"`);${versionArg} -d "${projectFolder.uri.fsPath}"`);
    if (!sr || sr.code !== 0) {
        await vscode.window.showErrorMessage(`Helm fetch failed: ${sr ? sr.stderr : "Unable to run Helm"}`);wErrorMessage(`Helm fetch failed: ${sr ? sr.stderr : "Unable to run Helm"}`);
        return;
    }
    await vscode.window.showInformationMessage(`Fetched ${chartId}`);wait vscode.window.showInformationMessage(`Fetched ${chartId}`);
}

export async function helmInstall(kubectl: Kubectl, helmObject: helmrepoexplorer.HelmObject | undefined): Promise<void> {export async function helmInstall(kubectl: Kubectl, helmObject: helmrepoexplorer.HelmObject | undefined): Promise<void> {
    if (!helmObject) {
        const values = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.getText() : undefined; vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.getText() : undefined;
        if (!values) {
            vscode.window.showWarningMessage(`Invalid values, please check it and try again.`);dow.showWarningMessage(`Invalid values, please check it and try again.`);
            return;
        }
        const repos: helmrepoexplorer.HelmRepo[] = (await helmRepoExplorer.getChildren()) as helmrepoexplorer.HelmRepo[] || [];onst repos: helmrepoexplorer.HelmRepo[] = (await helmRepoExplorer.getChildren()) as helmrepoexplorer.HelmRepo[] || [];
        const repoDictionary: Map<string, helmrepoexplorer.HelmRepo> = new Map();
        repos.forEach((r) => repoDictionary.set(r.name, r));
        const repoId = await vscode.window.showQuickPick(repos.map((r) => r.name), { canPickMany: false });os.map((r) => r.name), { canPickMany: false });
        if (!repoId || !repoDictionary.has(repoId)) {
            vscode.window.showErrorMessage(`Helm repository ${repoId} is missing or mismatch.`);sitory ${repoId} is missing or mismatch.`);
            return;
        }
        const charts = (await helmRepoExplorer.getChildren(repoDictionary.get(repoId))) as helmrepoexplorer.HelmRepoChart[] || [];onst charts = (await helmRepoExplorer.getChildren(repoDictionary.get(repoId))) as helmrepoexplorer.HelmRepoChart[] || [];
        const chartDictionary = new Map<string, helmrepoexplorer.HelmRepoChart>();
        charts.forEach((c) => chartDictionary.set(c.id, c));
        const chartId = await vscode.window.showQuickPick(charts.map((r) => r.id), { canPickMany: false });arts.map((r) => r.id), { canPickMany: false });
        if (!chartId || !shell.isSafe(chartId) || !chartDictionary.has(chartId)) {
            vscode.window.showErrorMessage(`Helm chart name ${chartId} is required.`);.`);
            return;
        }
        const versions = (await helmRepoExplorer.getChildren(chartDictionary.get(chartId))) as helmrepoexplorer.HelmRepoChartVersion[];onst versions = (await helmRepoExplorer.getChildren(chartDictionary.get(chartId))) as helmrepoexplorer.HelmRepoChartVersion[];
        const versionDictionary = new Map<string, helmrepoexplorer.HelmRepoChartVersion>();
        versions.forEach((v) => versionDictionary.set(v.version, v));
        const version = await vscode.window.showQuickPick(versions.map((r) => r.version), { canPickMany: false });p((r) => r.version), { canPickMany: false });
        if (!version || !shell.isSafe(version) || !versionDictionary.has(version)) {
            vscode.window.showErrorMessage(`Helm chart version ${version} is required.`);d.`);
            return;
        }
        const namespaces = (await kubectlUtils.getNamespaces(kubectl));onst namespaces = (await kubectlUtils.getNamespaces(kubectl));
        const namespace = await vscode.window.showQuickPick(namespaces.map((n) => n.name), { canPickMany: false, title: `Please select the target namespace to install:` });map((n) => n.name), { canPickMany: false, title: `Please select the target namespace to install:` });
        if (!namespace) {
            vscode.window.showErrorMessage(`Helm release namespace is required.`);.showErrorMessage(`Helm release namespace is required.`);
            return;
        }
        const release = await vscode.window.showInputBox({ title: `Please specify the release name:` });onst release = await vscode.window.showInputBox({ title: `Please specify the release name:` });
        if (release) {
            helmInstallCore(kubectl, release, chartId, version, values, namespace);lCore(kubectl, release, chartId, version, values, namespace);
        }
        return;eturn;
    }
    if (helmrepoexplorer.isHelmRepoChart(helmObject)) {f (helmrepoexplorer.isHelmRepoChart(helmObject)) {
        await helmInstallCore(kubectl, undefined, helmObject.id, undefined, undefined, undefined);bject.id, undefined, undefined, undefined);
    } else if (helmrepoexplorer.isHelmRepoChartVersion(helmObject)) {
        await helmInstallCore(kubectl, undefined, helmObject.id, helmObject.version, undefined, undefined);Object.version, undefined, undefined);
    }
}

export async function helmRegisterTextDocumentContentProvider() {export async function helmRegisterTextDocumentContentProvider() {
    vscode.workspace.registerTextDocumentContentProvider(helm.HELM_VALUES_SCHEMA, {M_VALUES_SCHEMA, {
        async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {nToken): Promise<string> {
            if (uri.scheme === helm.HELM_VALUES_SCHEMA && !token.isCancellationRequested) {
                const ns = uri.authority;
                const values = uri.fsPath;;
                const release = values.substring('helmrelease-'.length + 1, values.length - ".yml".length);string('helmrelease-'.length + 1, values.length - ".yml".length);
                const sr = await helmExecAsync(`get values ${release} --namespace ${ns}`);
                return sr ? (sr.stdout || sr.stderr) : `Unable to get values of ${ns}/${release}`;lease}`;
            }
            return `Unable to get values of ${uri.toString}`;eturn `Unable to get values of ${uri.toString}`;
        }
    });
}

export async function helmExportValues(kubectl: Kubectl, res: ClusterExplorerHelmReleaseNode): Promise<void> {export async function helmExportValues(kubectl: Kubectl, res: ClusterExplorerHelmReleaseNode): Promise<void> {
    const ns = await currentNamespace(kubectl);
    const uri = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri : vscode.Uri.parse("");rs ? vscode.workspace.workspaceFolders[0].uri : vscode.Uri.parse("");
    const filename = filepath.join(uri.fsPath, `helmrelease-${res.releaseName}.yml`);
    const sr = await helmExecAsync(`get values ${res.releaseName} --namespace ${ns}`);;
    let content = `Unable to get values of ${ns}/${res.releaseName}`;
    if (sr) {
        if (sr.code === 0) {r.code === 0) {
            content = sr.stdout.substring("USER-SUPPLIED VALUES:".length + 1).trimLeft();out.substring("USER-SUPPLIED VALUES:".length + 1).trimLeft();
            writeFileSync(filename, content);
            vscode.workspace.openTextDocument(filename).then((doc) => {(filename).then((doc) => {
                vscode.window.showTextDocument(doc).then((editor) => {
                    editor.edit((builder) => {
                        builder.replace(new vscode.Range(new vscode.Position(0, 0),code.Range(new vscode.Position(0, 0),
                            doc.lineAt(doc.lineCount - 1).range.end), content);
                    });
                });
            });
        } else {{
            content = sr.stderr;ent = sr.stderr;
            vscode.window.showInformationMessage(`Helm: exporting (${filename}) : ${content}`);formationMessage(`Helm: exporting (${filename}) : ${content}`);
        }
    }
}

export async function helmGetValues(kubectl: Kubectl, res: HelmReleaseNode): Promise<void> {export async function helmGetValues(kubectl: Kubectl, res: HelmReleaseNode): Promise<void> {
    const ns = await currentNamespace(kubectl);
    const uri = vscode.Uri.parse(`${helm.HELM_VALUES_SCHEMA}://${ns}/helmrelease-${res.releaseName}.yml`);ALUES_SCHEMA}://${ns}/helmrelease-${res.releaseName}.yml`);
    const sr = await helmExecAsync(`get values ${res.releaseName} --namespace ${ns}`);
    let content = `Unable to get values of ${ns}/${res.releaseName}`;
    if (sr) {
        if (sr.code === 0) {r.code === 0) {
            const metadata: { tips: string; namespace: string; chart: string; releaseName: string } = {{ tips: string; namespace: string; chart: string; releaseName: string } = {
                tips: `DO NOT REMOVE THIS COMMENT!!!`,
                namespace: ns,
                chart: res.chart,rt,
                releaseName: res.releaseNamereleaseName
            };
            content = `#${JSON.stringify(metadata)}\n` + sr.stdout.substring("USER-SUPPLIED VALUES:".length + 1).trimLeft();ntent = `#${JSON.stringify(metadata)}\n` + sr.stdout.substring("USER-SUPPLIED VALUES:".length + 1).trimLeft();
            vscode.workspace.openTextDocument({ language: "yaml", content }).then((doc) => {
                vscode.window.showTextDocument(doc);
            });
        } else {{
            content = sr.stderr;ent = sr.stderr;
            vscode.window.showInformationMessage(`Helm: previewing (${uri.toString()}) : ${content}`);formationMessage(`Helm: previewing (${uri.toString()}) : ${content}`);
        }
    }
}

export async function helmUpgradeWithValues(): Promise<void> {export async function helmUpgradeWithValues(): Promise<void> {
    const content = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.getText() : undefined;ndow.activeTextEditor.document.getText() : undefined;
    if (!content) {
        vscode.window.showWarningMessage(`Invalid content values, please check it and try again.`);ow.showWarningMessage(`Invalid content values, please check it and try again.`);
        return;
    }
    const matched = content.match(/^#+([^\n]+)/);onst matched = content.match(/^#+([^\n]+)/);
    let metadata: { namespace: string; chart: string; releaseName: string } | undefined = undefined;ing; releaseName: string } | undefined = undefined;
    try {
        metadata = JSON.parse(matched ? matched[1] : "{}");etadata = JSON.parse(matched ? matched[1] : "{}");
    } catch (e) { }
    if (!metadata || !metadata.namespace || !metadata.releaseName) {| !metadata.namespace || !metadata.releaseName) {
        const releases = await helmListAll();
        if (!releases || !releases.succeeded) { {
            vscode.window.showWarningMessage(`Missing metadata in values or unable to list releases.`);issing metadata in values or unable to list releases.`);
            return;
        }
        const releaseName = await vscode.window.showQuickPick(releases.result.map((r) => r.name), { canPickMany: false });onst releaseName = await vscode.window.showQuickPick(releases.result.map((r) => r.name), { canPickMany: false });
        const release = releases.result.filter((r) => r.name === releaseName)[0];
        if (!releaseName || !release) {
            vscode.window.showWarningMessage(`Release to upgrade is required but not provided.`);ssage(`Release to upgrade is required but not provided.`);
            return;
        }
        metadata = { namespace: release.namespace, chart: release.chart, releaseName: releaseName };etadata = { namespace: release.namespace, chart: release.chart, releaseName: releaseName };
    }

    if (!ensureHelm(EnsureMode.Alert)) {    if (!ensureHelm(EnsureMode.Alert)) {
        return;
    }

    const chart = metadata.chart.match(/^(.*)-([^-]+)$/)!.slice(1);    const chart = metadata.chart.match(/^(.*)-([^-]+)$/)!.slice(1);

    const repos: helmrepoexplorer.HelmRepo[] = (await helmRepoExplorer.getChildren()) as helmrepoexplorer.HelmRepo[] || [];    const repos: helmrepoexplorer.HelmRepo[] = (await helmRepoExplorer.getChildren()) as helmrepoexplorer.HelmRepo[] || [];
    const repoDictionary: Map<string, helmrepoexplorer.HelmRepo> = new Map();
    repos.forEach((r) => repoDictionary.set(r.name, r));
    const repoId = await vscode.window.showQuickPick(repos.map((r) => r.name), { canPickMany: false });os.map((r) => r.name), { canPickMany: false });
    if (!repoId || !repoDictionary.has(repoId)) {
        vscode.window.showErrorMessage(`Helm repository ${repoId} is missing or mismatch.`);sitory ${repoId} is missing or mismatch.`);
        return;
    }
    const charts = (await helmRepoExplorer.getChildren(repoDictionary.get(repoId))) as helmrepoexplorer.HelmRepoChart[] || [];onst charts = (await helmRepoExplorer.getChildren(repoDictionary.get(repoId))) as helmrepoexplorer.HelmRepoChart[] || [];
    const chartDictionary = new Map<string, helmrepoexplorer.HelmRepoChart>();
    charts.forEach((c) => chartDictionary.set(c.id, c));
    const chartId = await vscode.window.showQuickPick(charts.map((r) => r.id), { placeHolder: `${repoId}/${chart[0]}`, canPickMany: false });arts.map((r) => r.id), { placeHolder: `${repoId}/${chart[0]}`, canPickMany: false });
    if (!chartId || !shell.isSafe(chartId) || !chartDictionary.has(chartId)) {
        vscode.window.showErrorMessage(`Helm chart name ${chartId} is required.`);.`);
        return;
    }
    const versions = (await helmRepoExplorer.getChildren(chartDictionary.get(chartId))) as helmrepoexplorer.HelmRepoChartVersion[];onst versions = (await helmRepoExplorer.getChildren(chartDictionary.get(chartId))) as helmrepoexplorer.HelmRepoChartVersion[];
    const versionDictionary = new Map<string, helmrepoexplorer.HelmRepoChartVersion>();
    versions.forEach((v) => versionDictionary.set(v.version, v));
    const version = await vscode.window.showQuickPick(versions.map((r) => r.version), { placeHolder: chart[1], canPickMany: false });p((r) => r.version), { placeHolder: chart[1], canPickMany: false });
    if (!version || !shell.isSafe(version) || !versionDictionary.has(version)) {
        vscode.window.showErrorMessage(`Helm chart version ${version} is required.`);d.`);
        return;
    }

    const release = metadata.releaseName;    const release = metadata.releaseName;
    const nsArg = `--namespace ${metadata.namespace}`;.namespace}`;
    const versionArg = version ? `--version ${version}` : '';` : '';
    const valuesArg = `--debug -f -`;
    const command = `upgrade ${release} ${chartId} ${versionArg} ${nsArg} ${valuesArg}`;e} ${chartId} ${versionArg} ${nsArg} ${valuesArg}`;
    vscode.window.showInformationMessage(`Helm [${command}]`);
    const sr = await helmExecAsync(command, content);
    if (!sr || sr.code !== 0) {
        const message = sr ? sr.stderr : `Unable to run Helm with :${command}`;.stderr : `Unable to run Helm with :${command}`;
        logger.log(message);
        await vscode.window.showErrorMessage(`Helm upgrade failed: ${message}`);showErrorMessage(`Helm upgrade failed: ${message}`);
        return;
    }
    const releaseName = extractReleaseName(sr.stdout);onst releaseName = extractReleaseName(sr.stdout);
    logger.log(sr.stdout);
    await vscode.window.showInformationMessage(`Installed ${chartId} as release ${releaseName}`);owInformationMessage(`Installed ${chartId} as release ${releaseName}`);
}

async function helmInstallCore(kubectl: Kubectl, name: string | undefined, chartId: string, version: string | undefined, values: string | undefined, namespace: string | undefined): Promise<void> {async function helmInstallCore(kubectl: Kubectl, name: string | undefined, chartId: string, version: string | undefined, values: string | undefined, namespace: string | undefined): Promise<void> {
    if (!shell.isSafe(chartId)) {
        vscode.window.showWarningMessage(`Unexpected characters in chart name ${chartId}. Use Helm CLI to install this chart.`);Message(`Unexpected characters in chart name ${chartId}. Use Helm CLI to install this chart.`);
        return;
    }
    if (version && !shell.isSafe(version)) {f (version && !shell.isSafe(version)) {
        vscode.window.showWarningMessage(`Unexpected characters in chart version ${version}. Use Helm CLI to install this chart.`);expected characters in chart version ${version}. Use Helm CLI to install this chart.`);
        return;
    }

    const syntaxVersion = await helmSyntaxVersion();    const syntaxVersion = await helmSyntaxVersion();
    const ns = namespace || await currentNamespace(kubectl);ubectl);
    const nsArg = ns ? `--namespace ${ns}` : '';
    const versionArg = version ? `--version ${version}` : '';rsion}` : '';
    const generateNameArg = (!name && syntaxVersion === HelmSyntaxVersion.V3) ? '--generate-name' : '';yntaxVersion.V3) ? '--generate-name' : '';
    const additionalArg = values ? `-f -` : '';
    const sr = await helmExecAsync(`install ${name || ""} ${chartId} ${versionArg} ${nsArg} ${generateNameArg} ${additionalArg}`, values);ame || ""} ${chartId} ${versionArg} ${nsArg} ${generateNameArg} ${additionalArg}`, values);
    if (!sr || sr.code !== 0) {
        const message = sr ? sr.stderr : "Unable to run Helm";.stderr : "Unable to run Helm";
        logger.log(message);
        await vscode.window.showErrorMessage(`Helm install failed: ${message}`);showErrorMessage(`Helm install failed: ${message}`);
        return;
    }
    const releaseName = extractReleaseName(sr.stdout);onst releaseName = extractReleaseName(sr.stdout);
    logger.log(sr.stdout);
    await vscode.window.showInformationMessage(`Installed ${chartId} as release ${releaseName}`);owInformationMessage(`Installed ${chartId} as release ${releaseName}`);
}

const HELM_INSTALL_NAME_HEADER = "NAME:";const HELM_INSTALL_NAME_HEADER = "NAME:";

function extractReleaseName(helmOutput: string): string {function extractReleaseName(helmOutput: string): string {
    const lines = helmOutput.split('\n').map((l) => l.trim());m());
    const nameLine = lines.find((l) => l.startsWith(HELM_INSTALL_NAME_HEADER));LL_NAME_HEADER));
    if (!nameLine) {
        return '(unknown)';nown)';
    }
    return nameLine.substring(HELM_INSTALL_NAME_HEADER.length + 1).trim();eturn nameLine.substring(HELM_INSTALL_NAME_HEADER.length + 1).trim();
}

export async function helmDependencies(helmObject: helmrepoexplorer.HelmObject | undefined): Promise<void> {export async function helmDependencies(helmObject: helmrepoexplorer.HelmObject | undefined): Promise<void> {
    if (!helmObject) {
        const id = await vscode.window.showInputBox({ prompt: "Chart to show dependencies for", placeHolder: "stable/mychart" });it vscode.window.showInputBox({ prompt: "Chart to show dependencies for", placeHolder: "stable/mychart" });
        if (id) {
            helmDependenciesLaunchViewer(id, undefined);ependenciesLaunchViewer(id, undefined);
        }
    }
    if (helmrepoexplorer.isHelmRepoChart(helmObject)) {f (helmrepoexplorer.isHelmRepoChart(helmObject)) {
        await helmDependenciesLaunchViewer(helmObject.id, undefined);d, undefined);
    } else if (helmrepoexplorer.isHelmRepoChartVersion(helmObject)) {
        await helmDependenciesLaunchViewer(helmObject.id, helmObject.version);version);
    }
}

async function helmDependenciesLaunchViewer(chartId: string, version: string | undefined): Promise<void> {async function helmDependenciesLaunchViewer(chartId: string, version: string | undefined): Promise<void> {
    if (!shell.isSafe(chartId)) {
        vscode.window.showWarningMessage(`Unexpected characters in chart name ${chartId}. Use Helm CLI to install this chart.`);Message(`Unexpected characters in chart name ${chartId}. Use Helm CLI to install this chart.`);
        return;
    }
    if (version && !shell.isSafe(version)) {f (version && !shell.isSafe(version)) {
        vscode.window.showWarningMessage(`Unexpected characters in chart version ${version}. Use Helm CLI to install this chart.`);expected characters in chart version ${version}. Use Helm CLI to install this chart.`);
        return;
    }

    // Boing it back through a HTML preview window    // Boing it back through a HTML preview window
    const versionQuery = version ? `?${version}` : ''; '';
    const uri = vscode.Uri.parse(`${helm.DEPENDENCIES_SCHEME}://${helm.DEPENDENCIES_REPO_AUTHORITY}/${chartId}${versionQuery}`);SCHEME}://${helm.DEPENDENCIES_REPO_AUTHORITY}/${chartId}${versionQuery}`);
    await preview(uri, vscode.ViewColumn.Two, `${chartId} Dependencies`);
}

export async function helmDependenciesCore(chartId: string, version: string | undefined): Promise<Errorable<{ [key: string]: string }[]>> {export async function helmDependenciesCore(chartId: string, version: string | undefined): Promise<Errorable<{ [key: string]: string }[]>> {
    const tempDirObj = tmp.dirSync({ prefix: "vsk-fetchfordeps-", unsafeCleanup: true });
    const versionArg = version ? `--version ${version}` : '';
    const fsr = await helmExecAsync(`fetch ${chartId} ${versionArg} -d "${tempDirObj.name}"`);onArg} -d "${tempDirObj.name}"`);
    if (!fsr || fsr.code !== 0) {
        tempDirObj.removeCallback();();
        return { succeeded: false, error: [`Helm fetch failed: ${fsr ? fsr.stderr : "Unable to run Helm"}`] };rror: [`Helm fetch failed: ${fsr ? fsr.stderr : "Unable to run Helm"}`] };
    }

    const tempDirFiles = sh.ls(tempDirObj.name);    const tempDirFiles = sh.ls(tempDirObj.name);
    const chartPath = filepath.join(tempDirObj.name, tempDirFiles[0]);  // should be the only thing in the directoryame, tempDirFiles[0]);  // should be the only thing in the directory
    try {
        const dsr = await helmExecAsync(`dep list "${chartPath}"`);onst dsr = await helmExecAsync(`dep list "${chartPath}"`);
        if (!dsr || dsr.code !== 0) {
            return { succeeded: false, error: [`Helm dependency list failed: ${dsr ? dsr.stderr : "Unable to run Helm"}`] };, error: [`Helm dependency list failed: ${dsr ? dsr.stderr : "Unable to run Helm"}`] };
        }
        const lines = dsr.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);onst lines = dsr.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
        if (lines.length === 1) {
            return { succeeded: false, error: [`${chartId} has no dependencies`] };  // I don't feel good about using an error for this but life is shortalse, error: [`${chartId} has no dependencies`] };  // I don't feel good about using an error for this but life is short
        }
        const dependencies = parseLineOutput(lines, helm.HELM_OUTPUT_COLUMN_SEPARATOR);onst dependencies = parseLineOutput(lines, helm.HELM_OUTPUT_COLUMN_SEPARATOR);
        return { succeeded: true, result: dependencies };
    } finally {
        fs.unlinkSync(chartPath);nkSync(chartPath);
        tempDirObj.removeCallback();();
    }
}

// pickChart tries to find charts in this repo. If one is found, fn() is executed with that// pickChart tries to find charts in this repo. If one is found, fn() is executed with that
// chart's path. If more than one are found, the user is prompted to choose one, and then
// the fn is executed with that chart.
//
// callback is fn(path) callback is fn(path)
export function pickChart(fn: (chartPath: string) => void) {rt(fn: (chartPath: string) => void) {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {ce.workspaceFolders.length === 0) {
        vscode.window.showErrorMessage("This command requires an open folder.");
        return;
    }
    findChartFiles().then((matches) => {indChartFiles().then((matches) => {
        switch (matches.length) {
            case 0:
                vscode.window.showErrorMessage("No charts found");ode.window.showErrorMessage("No charts found");
                return;
            case 1:
                // Assume that if there is only one chart, that's the one to run.Assume that if there is only one chart, that's the one to run.
                const p = filepath.dirname(matches[0].fsPath);
                fn(p);
                return;;
            default:
                // TODO: This would be so much cooler if the QuickPick parsed the Chart.yamlODO: This would be so much cooler if the QuickPick parsed the Chart.yaml
                // and showed the chart name instead of the path.
                const pathPicks = matches.map((item) =>
                    quickPickForChart(item)
                );
                vscode.window.showQuickPick(pathPicks).then((picked) => {code.window.showQuickPick(pathPicks).then((picked) => {
                    if (picked) {
                        fn(picked.chartDir);.chartDir);
                    }
                });
                return;urn;
        }
    });
}

function quickPickForChart(chartUri: vscode.Uri): vscode.QuickPickItem & { readonly chartDir: string } {function quickPickForChart(chartUri: vscode.Uri): vscode.QuickPickItem & { readonly chartDir: string } {
    const chartDir = filepath.dirname(chartUri.fsPath);
    const displayName = vscode.workspace.rootPath ?
        filepath.relative(vscode.workspace.rootPath, chartDir) :, chartDir) :
        chartDir;
    return {
        label: displayName || ".",l: displayName || ".",
        chartDir: chartDir
    };
}

interface Chart {interface Chart {
    name: string;
    version: string;ng;
    appVersion: string;ng;
}

// Load a chart object// Load a chart object
export function loadChartMetadata(chartDir: string): Chart | undefined {artMetadata(chartDir: string): Chart | undefined {
    const f = filepath.join(chartDir, "Chart.yaml");
    let c: Chart | undefined;
    try {
        c = YAML.load(readFileSync(f, 'utf8')) as Chart; = YAML.load(readFileSync(f, 'utf8')) as Chart;
    } catch (err) {
        vscode.window.showErrorMessage("Chart.yaml: " + err);ow.showErrorMessage("Chart.yaml: " + err);
    }
    return c;eturn c;
}

// Given a file, show any charts that this file belongs to.// Given a file, show any charts that this file belongs to.
export function pickChartForFile(file: string, options: PickChartUIOptions, fn: (path: string) => void) {kChartUIOptions, fn: (path: string) => void) {
    findChartFiles().then((matches) => {
        switch (matches.length) {
            case 0:
                if (options.warnIfNoCharts) {(options.warnIfNoCharts) {
                    vscode.window.showErrorMessage("No charts found");ssage("No charts found");
                }
                return;eturn;
            case 1:
                // Assume that if there is only one chart, that's the one to run.Assume that if there is only one chart, that's the one to run.
                const p = filepath.dirname(matches[0].fsPath);
                fn(p);
                return;;
            default:
                const paths = Array.of<string>();t paths = Array.of<string>();

                matches.forEach((item) => {                matches.forEach((item) => {
                    const dirname = filepath.dirname(item.fsPath);h.dirname(item.fsPath);
                    const rel = filepath.relative(dirname, file);

                    // If the present file is not in a subdirectory of the parent chart, skip the chart.                    // If the present file is not in a subdirectory of the parent chart, skip the chart.
                    if (rel.indexOf("..") >= 0) {
                        return;
                    }

                    paths.push(dirname);                    paths.push(dirname);
                });

                if (paths.length === 0) {                if (paths.length === 0) {
                    if (options.warnIfNoCharts) {harts) {
                        vscode.window.showErrorMessage("Chart not found for " + file);ssage("Chart not found for " + file);
                    }
                    return;eturn;
                }

                // For now, let's go with the top-most path (umbrella chart)                // For now, let's go with the top-most path (umbrella chart)
                if (paths.length >= 1) {
                    fn(paths[0]);
                    return;
                }
                return;eturn;
        }
    });
}

function findChartFiles() {function findChartFiles() {
    // Excluding "**/node_modules/**" as a common cause of excessive CPU usage.odules/**" as a common cause of excessive CPU usage.
    // https://github.com/microsoft/vscode/issues/75314#issuecomment-503195666
    return vscode.workspace.findFiles("**/Chart.yaml", "**/node_modules/**", 1024);024);
}

// helmExec appends 'args' to a Helm command (helm args...), executes it, and then sends the result to te callback.// helmExec appends 'args' to a Helm command (helm args...), executes it, and then sends the result to te callback.
// fn should take the signature function(code, stdout, stderr)
//
// This will abort and send an error message if Helm is not installed. This will abort and send an error message if Helm is not installed.

export function helmExec(args: string, fn: ExecCallback, stdin?: string) {export function helmExec(args: string, fn: ExecCallback, stdin?: string) {
    if (!ensureHelm(EnsureMode.Alert)) {
        return;
    }
    const configuredBin: string | undefined = getToolPath(host, sh, 'helm');onst configuredBin: string | undefined = getToolPath(host, sh, 'helm');
    const bin = configuredBin ? `"${configuredBin}"` : "helm";
    const cmd = `${bin} ${args}`;
    const promise = sh.exec(cmd, stdin);stdin);
    promise.then((res: ShellResult | undefined) => {efined) => {
        if (res) {
            fn(res.code, res.stdout, res.stderr);.code, res.stdout, res.stderr);
        } else {
            console.log('exec failed: unable to run Helm');ole.log('exec failed: unable to run Helm');
        }
    }, (err) => {rr) => {
        console.log(`exec failed! (${err})`);og(`exec failed! (${err})`);
    });
}

export async function helmExecAsync(args: string, stdin?: string): Promise<ShellResult | undefined> {export async function helmExecAsync(args: string, stdin?: string): Promise<ShellResult | undefined> {
    // TODO: deduplicate with helmExec
    if (!ensureHelm(EnsureMode.Alert)) { {
        return { code: -1, stdout: "", stderr: "" };tderr: "" };
    }
    const configuredBin: string | undefined = getToolPath(host, sh, 'helm');onst configuredBin: string | undefined = getToolPath(host, sh, 'helm');
    const bin = configuredBin ? `"${configuredBin}"` : "helm";
    const cmd = `${bin} ${args}`;
    return await sh.exec(cmd, stdin);in);
}

const HELM_BINARY: ExternalBinary = {const HELM_BINARY: ExternalBinary = {
    binBaseName: 'helm',
    configKeyName: 'helm',',
    displayName: 'Helm',
    offersInstall: true,
};

const HELM_CONTEXT: Context = {const HELM_CONTEXT: Context = {
    host: host,
    fs: shellfs,,
    shell: sh,
    pathfinder: undefined,: undefined,
    binary: HELM_BINARY,
    status: undefined,
};

export async function helmInvokeCommand(command: string): Promise<ExecResult> {export async function helmInvokeCommand(command: string): Promise<ExecResult> {
    return await invokeForResult(HELM_CONTEXT, command, undefined);
}

export async function helmInvokeCommandWithFeedback(command: string, uiOptions: string | LongRunningUIOptions): Promise<ExecResult> {export async function helmInvokeCommandWithFeedback(command: string, uiOptions: string | LongRunningUIOptions): Promise<ExecResult> {
    return await HELM_CONTEXT.host.longRunning(uiOptions, () =>
        invokeForResult(HELM_CONTEXT, command, undefined)
    );
}

const HELM_PAGING_PREFIX = "next:";const HELM_PAGING_PREFIX = "next:";

export async function helmListAll(namespace?: string): Promise<Errorable<{ [key: string]: string }[]>> {export async function helmListAll(namespace?: string): Promise<Errorable<{ [key: string]: string }[]>> {
    if (!ensureHelm(EnsureMode.Alert)) {
        return { succeeded: false, error: ["Helm client is not installed"] };: ["Helm client is not installed"] };
    }

    const releases: { [key: string]: string }[] = [];    const releases: { [key: string]: string }[] = [];
    let offset: string | null = null;

    do {    do {
        const nsarg = namespace ? `--namespace ${namespace}` : "";const nsarg = namespace ? `--namespace ${namespace}` : "";
        const offsetarg: string = offset ? `--offset ${offset}` : "";"";
        const sr = await helmExecAsync(`list --max 0 ${nsarg} ${offsetarg}`);targ}`);

        if (!sr || sr.code !== 0) {        if (!sr || sr.code !== 0) {
            return { succeeded: false, error: [sr ? sr.stderr : "Unable to run Helm"] };se, error: [sr ? sr.stderr : "Unable to run Helm"] };
        }

        const lines = sr.stdout.split('\n')        const lines = sr.stdout.split('\n')
            .map((s) => s.trim())
            .filter((l) => l.length > 0);th > 0);
        if (lines.length > 0) {
            if (lines[0].startsWith(HELM_PAGING_PREFIX)) {With(HELM_PAGING_PREFIX)) {
                const pagingInfo = lines.shift()!;  // safe because we have checked the lengthe because we have checked the length
                offset = pagingInfo.substring(HELM_PAGING_PREFIX.length).trim();
            } else {
                offset = null;et = null;
            }
        }
        if (lines.length > 0) {f (lines.length > 0) {
            const helmReleases = parseLineOutput(lines, helm.HELM_OUTPUT_COLUMN_SEPARATOR);= parseLineOutput(lines, helm.HELM_OUTPUT_COLUMN_SEPARATOR);
            releases.push(...helmReleases);
        }
    } while (offset !== null);le (offset !== null);

    return { succeeded: true, result: releases };    return { succeeded: true, result: releases };
}

export function ensureHelm(mode: EnsureMode) {export function ensureHelm(mode: EnsureMode) {
    const configuredBin: string | undefined = getToolPath(host, sh, 'helm');getToolPath(host, sh, 'helm');
    if (configuredBin) {
        if (fs.existsSync(configuredBin)) {c(configuredBin)) {
            return true;
        }
        if (mode === EnsureMode.Alert) {f (mode === EnsureMode.Alert) {
            vscode.window.showErrorMessage(`${configuredBin} does not exist!`, "Install dependencies").then((str) => {ge(`${configuredBin} does not exist!`, "Install dependencies").then((str) => {
                if (str === "Install dependencies") {
                    installDependencies();
                }
            });
        }
        return false;eturn false;
    }
    if (sh.which("helm")) {f (sh.which("helm")) {
        return true;
    }
    if (mode === EnsureMode.Alert) {f (mode === EnsureMode.Alert) {
        vscode.window.showErrorMessage(`Could not find Helm binary.`, "Install dependencies").then((str) => {ge(`Could not find Helm binary.`, "Install dependencies").then((str) => {
            if (str === "Install dependencies") {
                installDependencies();
            }
        });
    }
    return false;eturn false;
}

export class Requirement {export class Requirement {
    constructor(public repository: string, public name: string, public version: string) {ository: string, public name: string, public version: string) {
    }
    toString(): string {oString(): string {
        return `- name: ${this.name}${this.name}
  version: ${this.version}
  repository: ${this.repository}itory}
`;
    }  }
}

export function insertRequirement() {export function insertRequirement() {
    vscode.window.showInputBox({
        prompt: "Chart",
        placeHolder: "stable/redis",able/redis",
    }).then((val) => {
        if (!val) {
            return;
        }
        const req = searchForChart(val);onst req = searchForChart(val);
        if (!req) {
            vscode.window.showErrorMessage(`Chart ${val} not found`);window.showErrorMessage(`Chart ${val} not found`);
            return;
        }
        const ed = vscode.window.activeTextEditor;onst ed = vscode.window.activeTextEditor;
        if (!ed) {
            logger.log(YAML.dump(req));.log(YAML.dump(req));
            return;
        }
        ed.insertSnippet(new vscode.SnippetString(req.toString()));d.insertSnippet(new vscode.SnippetString(req.toString()));
    });
}

// searchForChart takes a 'repo/name' and returns an entry suitable for requirements// searchForChart takes a 'repo/name' and returns an entry suitable for requirements
export function searchForChart(name: string): Requirement | undefined {
    const parts = name.split("/", 2);
    if (parts.length !== 2) {
        logger.log("Chart should be of the form REPO/CHARTNAME");uld be of the form REPO/CHARTNAME");
        return undefined;
    }
    const hh = helmHome();onst hh = helmHome();
    const reposFile = filepath.join(hh, "repository", "repositories.yaml");path.join(hh, "repository", "repositories.yaml");
    if (!fs.existsSync(reposFile)) {
        vscode.window.showErrorMessage(`Helm repositories file ${reposFile} not found.`);ge(`Helm repositories file ${reposFile} not found.`);
        return undefined;
    }
    const repos: HelmRepositoriesFile = YAML.load(reposFile) as HelmRepositoriesFile;onst repos: HelmRepositoriesFile = YAML.load(reposFile) as HelmRepositoriesFile;
    let req;
    repos.repositories.forEach((repo) => {positories.forEach((repo) => {
        if (repo.name === parts[0]) {
            const cache = YAML.load(repo.cache) as { entries: [] };epo.cache) as { entries: [] };
            _.each(cache.entries, (releases, n) => {
                const name = n.toString();
                if (name === parts[1]) {
                    req = new Requirement(repo.url, name, (releases as { version: string }[])[0].version);t(repo.url, name, (releases as { version: string }[])[0].version);
                    return;
                }
            });
            return;urn;
        }
    });
    return req;urn req;
}

export function helmHome(): string {export function helmHome(): string {
    const h = sh.home();
    return process.env["HELM_HOME"] || filepath.join(h, '.helm');HELM_HOME"] || filepath.join(h, '.helm');
}
