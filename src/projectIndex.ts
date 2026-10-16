import * as path from 'path';
import * as vscode from 'vscode';
import { type PpjProject, findPpjUpwards, listScripts, readPpj, scriptNamesFor } from './ppj';

/** Script names shorter than this aren't colored as types (so A.psc doesn't color every "a"). */
const minColoredNameLength = 4;

/**
 * Knows every .psc in the source folders of the .ppj projects in use.
 *
 * Projects come from .ppj files in the workspace, plus .ppj files in the folder (or parent
 * folders) of any Papyrus file you open, so scripts outside the workspace work too.
 * Folder contents are watched, so adding or deleting a script updates colors and lookups.
 */
export class ProjectIndex implements vscode.Disposable {
    private readonly projects = new Map<string, PpjProject>();
    private readonly folderFiles = new Map<string, string[]>();
    private readonly folderLoads = new Map<string, Promise<void>>();
    private readonly folderWatchers = new Map<string, vscode.Disposable>();
    private readonly ppjWatchers = new Map<string, vscode.Disposable>();
    private readonly checkedDirs = new Set<string>();
    private readonly disposables: vscode.Disposable[] = [];
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    private changeTimer: NodeJS.Timeout | undefined;

    /** Lower-case script names that get the type color (file name longer than 3 characters). */
    scriptNames = new Set<string>();
    /** Lower-case script name -> .psc paths, in source folder priority order (all lengths). */
    private scriptPaths = new Map<string, string[]>();
    /** Script names as written (file name case), sorted, for autocomplete. */
    private displayNames: string[] = [];

    /** Fires (debounced) when the set of known scripts changes. */
    readonly onDidChange = this.changeEmitter.event;

    constructor(private readonly log: vscode.OutputChannel) {
        const ppjWatcher = vscode.workspace.createFileSystemWatcher('**/*.ppj');
        this.disposables.push(
            ppjWatcher,
            ppjWatcher.onDidCreate((uri) => void this.loadProject(uri.fsPath)),
            ppjWatcher.onDidChange((uri) => void this.loadProject(uri.fsPath)),
            ppjWatcher.onDidDelete((uri) => this.removeProject(uri.fsPath)),
            vscode.workspace.onDidOpenTextDocument((doc) => void this.checkDocument(doc))
        );
    }

    /** Finds and loads the workspace's .ppj files and those next to already open documents. */
    async initialize() {
        const files = await vscode.workspace.findFiles('**/*.ppj', '**/node_modules/**');
        await Promise.all(files.map((uri) => this.loadProject(uri.fsPath)));
        await Promise.all(vscode.workspace.textDocuments.map((doc) => this.checkDocument(doc)));
    }

    /** Loads .ppj files from a Papyrus document's folder and its parents (once per folder). */
    async checkDocument(doc: vscode.TextDocument) {
        if (doc.languageId !== 'papyrus' || doc.uri.scheme !== 'file') {
            return;
        }
        const dir = path.dirname(doc.uri.fsPath);
        const key = dir.toLowerCase();
        if (this.checkedDirs.has(key)) {
            return;
        }
        this.checkedDirs.add(key);

        for (const file of await findPpjUpwards(dir)) {
            if (!this.projects.has(file.toLowerCase())) {
                await this.loadProject(file);
                this.watchPpj(file);
            }
        }
    }

    /** The .psc file for a script name (highest priority folder first), if known. */
    findScript(name: string): string | undefined {
        return this.scriptPaths.get(name.toLowerCase())?.[0];
    }

    /** Every known .psc path for a script name. */
    findScripts(name: string): readonly string[] {
        return this.scriptPaths.get(name.toLowerCase()) ?? [];
    }

    /** Script names starting with `prefix` (case-insensitive), up to `limit`. */
    scriptNamesStartingWith(prefix: string, limit: number): string[] {
        const lower = prefix.toLowerCase();
        const result: string[] = [];
        for (const name of this.displayNames) {
            if (name.toLowerCase().startsWith(lower)) {
                result.push(name);
                if (result.length >= limit) {
                    break;
                }
            }
        }
        return result;
    }

    get projectList(): readonly PpjProject[] {
        return [...this.projects.values()];
    }

    get scriptCount(): number {
        let count = 0;
        for (const files of this.folderFiles.values()) {
            count += files.length;
        }
        return count;
    }

    private async loadProject(file: string) {
        const project = await readPpj(file);
        if (!project) {
            this.log.appendLine(`Couldn't read ${file}`);
            return;
        }

        this.projects.set(file.toLowerCase(), project);
        this.log.appendLine(`Project ${file}`);

        await Promise.all(project.folders.map((folder) => this.loadFolder(folder)));
        this.rebuild();
    }

    private removeProject(file: string) {
        if (this.projects.delete(file.toLowerCase())) {
            this.log.appendLine(`Project removed: ${file}`);
            this.rebuild();
        }
    }

    private watchPpj(file: string) {
        const key = file.toLowerCase();
        if (this.ppjWatchers.has(key)) {
            return;
        }
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file))
        );
        watcher.onDidChange(() => void this.loadProject(file));
        watcher.onDidCreate(() => void this.loadProject(file));
        watcher.onDidDelete(() => this.removeProject(file));
        this.ppjWatchers.set(key, watcher);
    }

    /** Lists a folder's scripts once, even if several projects ask for it at the same time. */
    private loadFolder(folder: string): Promise<void> {
        const key = folder.toLowerCase();
        let load = this.folderLoads.get(key);
        if (!load) {
            load = this.scanFolder(folder, key);
            this.folderLoads.set(key, load);
        }
        return load;
    }

    private async scanFolder(folder: string, key: string) {

        const started = Date.now();
        const files = await listScripts(folder);
        this.folderFiles.set(key, files);
        this.log.appendLine(`  ${folder}: ${files.length} scripts (${Date.now() - started} ms)`);

        // Keep the folder's file list current when scripts are added or deleted.
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(folder), '**/*.psc'),
            false,
            true,
            false
        );
        watcher.onDidCreate((uri) => {
            const list = this.folderFiles.get(key);
            if (list && !list.some((f) => f.toLowerCase() === uri.fsPath.toLowerCase())) {
                list.push(uri.fsPath);
                this.rebuild();
            }
        });
        watcher.onDidDelete((uri) => {
            const list = this.folderFiles.get(key);
            if (list) {
                const i = list.findIndex((f) => f.toLowerCase() === uri.fsPath.toLowerCase());
                if (i >= 0) {
                    list.splice(i, 1);
                    this.rebuild();
                }
            }
        });
        this.folderWatchers.set(key, watcher);
    }

    /** Rebuilds the name tables from the current projects, in folder priority order. */
    private rebuild() {
        const names = new Set<string>();
        const paths = new Map<string, string[]>();
        const display = new Map<string, string>();
        const usedFolders = new Set<string>();

        for (const project of this.projects.values()) {
            for (const folder of project.folders) {
                const key = folder.toLowerCase();
                usedFolders.add(key);
                for (const file of this.folderFiles.get(key) ?? []) {
                    const fileNames = scriptNamesFor(folder, file);
                    for (const name of fileNames) {
                        const lower = name.toLowerCase();
                        let list = paths.get(lower);
                        if (!list) {
                            list = [];
                            paths.set(lower, list);
                            display.set(lower, name);
                        }
                        list.push(file);
                    }
                    if (fileNames[0].length >= minColoredNameLength) {
                        fileNames.forEach((n) => names.add(n.toLowerCase()));
                    }
                }
            }
        }

        // Stop watching folders no project uses anymore.
        for (const [key, watcher] of this.folderWatchers) {
            if (!usedFolders.has(key)) {
                watcher.dispose();
                this.folderWatchers.delete(key);
                this.folderFiles.delete(key);
                this.folderLoads.delete(key);
            }
        }

        this.scriptNames = names;
        this.scriptPaths = paths;
        this.displayNames = [...display.values()].sort((a, b) => a.localeCompare(b));

        if (this.changeTimer) {
            clearTimeout(this.changeTimer);
        }
        this.changeTimer = setTimeout(() => this.changeEmitter.fire(), 200);
    }

    dispose() {
        if (this.changeTimer) {
            clearTimeout(this.changeTimer);
        }
        this.disposables.forEach((d) => d.dispose());
        this.folderWatchers.forEach((d) => d.dispose());
        this.ppjWatchers.forEach((d) => d.dispose());
        this.changeEmitter.dispose();
    }
}
