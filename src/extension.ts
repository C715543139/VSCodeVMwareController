import * as vscode from "vscode";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";

type VmPowerState = "running" | "suspended" | "stopped" | "missing" | "unknown";

type ConfiguredVm = {
    name: string;
    path: string;
};

type VmInfo = {
    name: string;
    vmxPath: string;
    state: VmPowerState;
    source: "configured" | "scanned";
};

function normalizePath(input: string): string {
    return path.resolve(input).toLowerCase();
}

function getVmDisplayName(vmxPath: string): string {
    return path.basename(vmxPath, ".vmx");
}

function getConfig() {
    const config = vscode.workspace.getConfiguration("vmware");

    return {
        vmrunPath: config.get<string>("vmrunPath") || "vmrun",
        scanRoots: config.get<string[]>("scanRoots") || [],
        vms: config.get<ConfiguredVm[]>("vms") || [],
        refreshIntervalMs: Math.max(config.get<number>("refreshIntervalMs") || 3000, 1000),
        maxScanDepth: Math.max(config.get<number>("maxScanDepth") || 5, 1)
    };
}

function runVmrun(args: string[]): Promise<string> {
    const { vmrunPath } = getConfig();

    return new Promise((resolve, reject) => {
        execFile(
            vmrunPath,
            args,
            {
                windowsHide: true,
                timeout: 60_000
            },
            (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr?.trim() || error.message));
                    return;
                }

                resolve(stdout.trim());
            }
        );
    });
}

async function listRunningVmPaths(): Promise<Set<string>> {
    const output = await runVmrun(["list"]);
    const result = new Set<string>();

    const lines = output
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    for (const line of lines) {
        if (line.toLowerCase().endsWith(".vmx")) {
            result.add(normalizePath(line));
        }
    }

    return result;
}

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function hasSuspendedState(vmxPath: string): Promise<boolean> {
    const vmDir = path.dirname(vmxPath);

    try {
        const entries = await fs.readdir(vmDir);
        return entries.some(entry => entry.toLowerCase().endsWith(".vmss"));
    } catch {
        return false;
    }
}

async function getVmState(vmxPath: string, runningSet: Set<string>): Promise<VmPowerState> {
    const normalized = normalizePath(vmxPath);

    if (!(await pathExists(vmxPath))) {
        return "missing";
    }

    if (runningSet.has(normalized)) {
        return "running";
    }

    if (await hasSuspendedState(vmxPath)) {
        return "suspended";
    }

    return "stopped";
}

async function scanForVmxFiles(root: string, maxDepth: number): Promise<string[]> {
    const result: string[] = [];

    async function walk(currentDir: string, depth: number) {
        if (depth > maxDepth) {
            return;
        }

        let entries: fsSync.Dirent[];

        try {
            entries = await fs.readdir(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                if (
                    entry.name === "node_modules" ||
                    entry.name === ".git" ||
                    entry.name === "$RECYCLE.BIN"
                ) {
                    continue;
                }

                await walk(fullPath, depth + 1);
                continue;
            }

            if (entry.isFile() && entry.name.toLowerCase().endsWith(".vmx")) {
                result.push(fullPath);
            }
        }
    }

    await walk(root, 0);
    return result;
}

async function discoverVms(): Promise<VmInfo[]> {
    const { vms, scanRoots, maxScanDepth } = getConfig();

    let runningSet = new Set<string>();

    try {
        runningSet = await listRunningVmPaths();
    } catch (error: any) {
        vscode.window.showWarningMessage(`VMware vmrun list failed: ${error.message}`);
    }

    const byPath = new Map<string, VmInfo>();

    for (const vm of vms) {
        const vmxPath = path.resolve(vm.path);
        const state = await getVmState(vmxPath, runningSet);

        byPath.set(normalizePath(vmxPath), {
            name: vm.name || getVmDisplayName(vmxPath),
            vmxPath,
            state,
            source: "configured"
        });
    }

    for (const root of scanRoots) {
        const resolvedRoot = path.resolve(root);
        const files = await scanForVmxFiles(resolvedRoot, maxScanDepth);

        for (const vmxPath of files) {
            const normalized = normalizePath(vmxPath);

            if (byPath.has(normalized)) {
                continue;
            }

            const state = await getVmState(vmxPath, runningSet);

            byPath.set(normalized, {
                name: getVmDisplayName(vmxPath),
                vmxPath,
                state,
                source: "scanned"
            });
        }
    }

    return Array.from(byPath.values()).sort((a, b) => {
        const stateOrder: Record<VmPowerState, number> = {
            running: 0,
            suspended: 1,
            stopped: 2,
            missing: 3,
            unknown: 4
        };

        return (
            stateOrder[a.state] - stateOrder[b.state] ||
            a.name.localeCompare(b.name)
        );
    });
}

class VmTreeItem extends vscode.TreeItem {
    constructor(public readonly vm: VmInfo) {
        super(vm.name, vscode.TreeItemCollapsibleState.None);

        this.description = vm.state;
        this.tooltip = [
            `Name: ${vm.name}`,
            `State: ${vm.state}`,
            `Source: ${vm.source}`,
            `Path: ${vm.vmxPath}`
        ].join("\n");

        this.contextValue = `vmwareVm.${vm.state}`;
        this.resourceUri = vscode.Uri.file(vm.vmxPath);

        this.iconPath = new vscode.ThemeIcon(this.getIconName(), this.getIconColor());

        this.command = {
            command: "vmwareController.openVmx",
            title: "Open VMX File",
            arguments: [this]
        };
    }

    private getIconName(): string {
        switch (this.vm.state) {
            case "running":
                return "debug-start";
            case "suspended":
                return "debug-pause";
            case "stopped":
                return "circle-outline";
            case "missing":
                return "warning";
            default:
                return "question";
        }
    }

    private getIconColor(): vscode.ThemeColor | undefined {
        switch (this.vm.state) {
            case "running":
                return new vscode.ThemeColor("testing.iconPassed");
            case "suspended":
                return new vscode.ThemeColor("testing.iconQueued");
            case "missing":
                return new vscode.ThemeColor("testing.iconFailed");
            default:
                return undefined;
        }
    }
}

class VmTreeProvider implements vscode.TreeDataProvider<VmTreeItem>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<VmTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this.emitter.event;

    private items: VmTreeItem[] = [];
    private refreshTimer: NodeJS.Timeout | undefined;
    private refreshInProgress = false;
    private disposables: vscode.Disposable[] = [];

    constructor() {
        this.setupPolling();
        this.setupFileWatchers();
    }

    getTreeItem(element: VmTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): VmTreeItem[] {
        return this.items;
    }

    async refresh(): Promise<void> {
        if (this.refreshInProgress) {
            return;
        }

        this.refreshInProgress = true;

        try {
            const vms = await discoverVms();
            this.items = vms.map(vm => new VmTreeItem(vm));
            this.emitter.fire();
        } finally {
            this.refreshInProgress = false;
        }
    }

    private setupPolling() {
        const { refreshIntervalMs } = getConfig();

        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }

        this.refreshTimer = setInterval(() => {
            this.refresh().catch(error => {
                console.error("VMware refresh failed:", error);
            });
        }, refreshIntervalMs);
    }

    private setupFileWatchers() {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];

        const { scanRoots } = getConfig();

        for (const root of scanRoots) {
            const pattern = new vscode.RelativePattern(root, "**/*.{vmx,vmss}");
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);

            watcher.onDidCreate(() => this.refresh());
            watcher.onDidChange(() => this.refresh());
            watcher.onDidDelete(() => this.refresh());

            this.disposables.push(watcher);
        }
    }

    async reloadConfiguration() {
        this.setupPolling();
        this.setupFileWatchers();
        await this.refresh();
    }

    dispose() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }

        this.disposables.forEach(d => d.dispose());
        this.emitter.dispose();
    }
}

async function executeVmAction(
    item: VmTreeItem | undefined,
    actionName: string,
    args: string[],
    provider: VmTreeProvider
) {
    if (!item) {
        vscode.window.showWarningMessage("No VM selected.");
        return;
    }

    const vm = item.vm;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `${actionName}: ${vm.name}`,
            cancellable: false
        },
        async () => {
            await runVmrun(args);
        }
    );

    await provider.refresh();
    vscode.window.showInformationMessage(`${actionName} completed: ${vm.name}`);
}

async function configureVmware(provider: VmTreeProvider) {
    const config = vscode.workspace.getConfiguration("vmware");

    const currentVmrunPath = config.get<string>("vmrunPath") || "vmrun";
    const currentScanRoots = config.get<string[]>("scanRoots") || [];
    const currentRefreshIntervalMs = config.get<number>("refreshIntervalMs") || 3000;

    const action = await vscode.window.showQuickPick(
        [
            {
                label: "$(file-binary) Set vmrun Path",
                description: currentVmrunPath
            },
            {
                label: "$(folder) Add VM Scan Folder",
                description: currentScanRoots.join("; ") || "No scan folders configured"
            },
            {
                label: "$(clear-all) Clear VM Scan Folders",
                description: "Remove all scan roots"
            },
            {
                label: "$(dashboard) Set Refresh Interval",
                description: `${currentRefreshIntervalMs} ms`
            }
        ],
        {
            placeHolder: "Configure VMware Controller"
        }
    );

    if (!action) {
        return;
    }

    if (action.label.includes("Set vmrun Path")) {
        const selected = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            openLabel: "Select vmrun executable",
            filters:
                process.platform === "win32"
                    ? { Executable: ["exe"] }
                    : undefined
        });

        if (!selected?.[0]) {
            return;
        }

        await config.update(
            "vmrunPath",
            selected[0].fsPath,
            vscode.ConfigurationTarget.Global
        );

        vscode.window.showInformationMessage("vmrun path updated.");
        await provider.reloadConfiguration();
        return;
    }

    if (action.label.includes("Add VM Scan Folder")) {
        const selected = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFiles: false,
            canSelectFolders: true,
            openLabel: "Add VM scan folder"
        });

        if (!selected?.length) {
            return;
        }

        const nextScanRoots = Array.from(
            new Set([
                ...currentScanRoots,
                ...selected.map(uri => uri.fsPath)
            ])
        );

        await config.update(
            "scanRoots",
            nextScanRoots,
            vscode.ConfigurationTarget.Global
        );

        vscode.window.showInformationMessage("VM scan folder added.");
        await provider.reloadConfiguration();
        return;
    }

    if (action.label.includes("Clear VM Scan Folders")) {
        const confirmed = await vscode.window.showWarningMessage(
            "Clear all configured VM scan folders?",
            { modal: true },
            "Clear"
        );

        if (confirmed !== "Clear") {
            return;
        }

        await config.update(
            "scanRoots",
            [],
            vscode.ConfigurationTarget.Global
        );

        vscode.window.showInformationMessage("VM scan folders cleared.");
        await provider.reloadConfiguration();
        return;
    }

    if (action.label.includes("Set Refresh Interval")) {
        const input = await vscode.window.showInputBox({
            prompt: "Refresh interval in milliseconds",
            value: String(currentRefreshIntervalMs),
            validateInput(value) {
                const num = Number(value);

                if (!Number.isFinite(num) || num < 1000) {
                    return "Please enter a number greater than or equal to 1000.";
                }

                return undefined;
            }
        });

        if (!input) {
            return;
        }

        await config.update(
            "refreshIntervalMs",
            Number(input),
            vscode.ConfigurationTarget.Global
        );

        vscode.window.showInformationMessage("Refresh interval updated.");
        await provider.reloadConfiguration();
    }
}

export async function activate(context: vscode.ExtensionContext) {
    const provider = new VmTreeProvider();

    context.subscriptions.push(provider);

    const treeView = vscode.window.createTreeView("vmwareController.vms", {
        treeDataProvider: provider,
        showCollapseAll: false
    });

    context.subscriptions.push(treeView);

    context.subscriptions.push(
        vscode.commands.registerCommand("vmwareController.refresh", async () => {
            await provider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("vmwareController.startOrResume", async (item?: VmTreeItem) => {
            await executeVmAction(
                item,
                "Start / Resume",
                ["start", item!.vm.vmxPath, "nogui"],
                provider
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("vmwareController.suspend", async (item?: VmTreeItem) => {
            await executeVmAction(
                item,
                "Suspend",
                ["suspend", item!.vm.vmxPath],
                provider
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("vmwareController.stopSoft", async (item?: VmTreeItem) => {
            await executeVmAction(
                item,
                "Stop Soft",
                ["stop", item!.vm.vmxPath, "soft"],
                provider
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("vmwareController.stopHard", async (item?: VmTreeItem) => {
            const confirmed = await vscode.window.showWarningMessage(
                `Hard stop may be similar to pulling the power plug. Continue stopping ${item?.vm.name}?`,
                { modal: true },
                "Stop Hard"
            );

            if (confirmed !== "Stop Hard") {
                return;
            }

            await executeVmAction(
                item,
                "Stop Hard",
                ["stop", item!.vm.vmxPath, "hard"],
                provider
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("vmwareController.resetSoft", async (item?: VmTreeItem) => {
            await executeVmAction(
                item,
                "Reset Soft",
                ["reset", item!.vm.vmxPath, "soft"],
                provider
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("vmwareController.resetHard", async (item?: VmTreeItem) => {
            const confirmed = await vscode.window.showWarningMessage(
                `Hard reset may cause data loss. Continue resetting ${item?.vm.name}?`,
                { modal: true },
                "Reset Hard"
            );

            if (confirmed !== "Reset Hard") {
                return;
            }

            await executeVmAction(
                item,
                "Reset Hard",
                ["reset", item!.vm.vmxPath, "hard"],
                provider
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("vmwareController.openVmx", async (item?: VmTreeItem) => {
            if (!item) {
                return;
            }

            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.vm.vmxPath));
            await vscode.window.showTextDocument(doc);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("vmwareController.revealFolder", async (item?: VmTreeItem) => {
            if (!item) {
                return;
            }

            await vscode.commands.executeCommand(
                "revealFileInOS",
                vscode.Uri.file(path.dirname(item.vm.vmxPath))
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("vmwareController.configure", async () => {
            await configureVmware(provider);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async event => {
            if (event.affectsConfiguration("vmware")) {
                await provider.reloadConfiguration();
            }
        })
    );

    await provider.refresh();
}

export function deactivate() { }
