import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { type PpjProject, findPpjUpwards, readPpj } from './ppj';
import { ProjectIndex } from './projectIndex';

const section = 'dylbillPapyrus.compiler';

interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

interface CompileOutcome {
    ok: boolean;
    succeeded: number;
    failed: number;
}

/** "C:\...\Foo.psc(12,5): message" or "(12,5,12,9): message" */
const errorLine = /^(.*?\.psc)\((\d+),(\d+)(?:,\d+,\d+)?\)\s*:\s*(.*)$/i;

/**
 * Compiles scripts with the compiler and options from the script's .ppj.
 *
 * The .ppj is looked for in the script's folder and its parent folders first (closest first),
 * then among the workspace's .ppj files.
 */
export class PapyrusCompiler implements vscode.Disposable {
    private readonly output = vscode.window.createOutputChannel('Papyrus Compiler');
    private readonly diagnostics = vscode.languages.createDiagnosticCollection('papyrus-compiler');
    private readonly disposables: vscode.Disposable[] = [];
    /** Compiles run one at a time, in order. */
    private queue: Promise<unknown> = Promise.resolve();
    /** Documents being saved by a compile command, so compile-on-save doesn't compile them twice. */
    private readonly savingForCompile = new Set<string>();

    constructor(private readonly index: ProjectIndex) {
        this.disposables.push(
            this.output,
            this.diagnostics,
            vscode.commands.registerCommand('dylbillPapyrus.compileScript', (uri?: vscode.Uri) =>
                this.enqueue(() => this.compileCurrent(uri))
            ),
            vscode.commands.registerCommand('dylbillPapyrus.compileAllTabs', () => this.enqueue(() => this.compileTabs())),
            vscode.commands.registerCommand('dylbillPapyrus.compileFolder', (uri?: vscode.Uri) =>
                this.enqueue(() => this.compileFolder(uri))
            ),
            vscode.workspace.onDidSaveTextDocument((doc) => {
                const key = doc.uri.toString();
                if (this.savingForCompile.has(key)) {
                    return;
                }
                if (isPsc(doc) && this.setting<boolean>('compileOnSave', false)) {
                    void this.enqueue(async () => {
                        this.startOutput();
                        const result = await this.compileFile(doc.uri.fsPath);
                        this.report(result, path.basename(doc.uri.fsPath), true);
                    });
                }
            })
        );
    }

    private enqueue(job: () => Promise<void>): Promise<void> {
        const run = this.queue.then(job, job).catch((e: unknown) => {
            this.output.appendLine(`Error: ${e instanceof Error ? e.message : String(e)}`);
            this.output.show(true);
        });
        this.queue = run;
        return run;
    }

    // ---- commands ------------------------------------------------------------------------

    private async compileCurrent(uri?: vscode.Uri) {
        const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!file || !/\.psc$/i.test(file)) {
            void vscode.window.showErrorMessage('Papyrus: open a .psc script to compile.');
            return;
        }
        await this.saveIfDirty([file]);
        this.startOutput();
        const result = await this.compileFile(file);
        this.report(result, path.basename(file), true);
    }

    private async compileTabs() {
        const files = openPscTabs();
        if (files.length === 0) {
            void vscode.window.showErrorMessage('Papyrus: no open .psc tabs to compile.');
            return;
        }
        await this.saveIfDirty(files);
        this.startOutput();

        let failed = 0;
        for (const file of files) {
            const result = await this.compileFile(file);
            if (!result.ok) {
                failed++;
            }
        }
        this.summary(failed === 0, failed > 0
            ? `${failed} of ${files.length} scripts failed to compile`
            : `Compiled all ${files.length} scripts successfully`);
    }

    private async compileFolder(uri?: vscode.Uri) {
        const target = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!target) {
            void vscode.window.showErrorMessage('Papyrus: open a .psc script to compile its folder.');
            return;
        }
        const isDir = fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ?? false;
        const folder = isDir ? target : path.dirname(target);
        if (!isDir && !/\.psc$/i.test(target)) {
            void vscode.window.showErrorMessage('Papyrus: open a .psc script to compile its folder.');
            return;
        }

        // Find the project from a script in the folder (or the folder itself).
        const project = await this.findProject(isDir ? path.join(folder, '_.psc') : target);
        if (!project) {
            return;
        }
        const recurse = !project.compile.noRecurse;
        const scripts = await listPsc(folder, recurse);
        if (scripts.length === 0) {
            void vscode.window.showErrorMessage(`Papyrus: no .psc scripts in ${folder}.`);
            return;
        }
        if (scripts.length > 100) {
            const answer = await vscode.window.showWarningMessage(
                `Compile all ${scripts.length} scripts in ${folder}${recurse ? ' and its subfolders' : ''}?`,
                { modal: true },
                'Compile'
            );
            if (answer !== 'Compile') {
                return;
            }
        }

        await this.saveIfDirty(scripts);
        this.startOutput();

        const exe = this.checkCompiler(project);
        if (!exe) {
            this.failure(`Couldn't compile ${path.basename(folder)}`, true);
            return;
        }

        const args = this.buildArgs(project, folder, folder, true);
        this.output.appendLine(`Compiling ${scripts.length} scripts in ${folder}`);
        this.output.appendLine(`Project: ${project.file}`);
        const run = await this.run(exe, args, folder);
        const outcome = this.evaluate(run, scripts);

        // Copy the outputs of every script that compiled.
        const failedFiles = new Set(this.diagnosticsFiles(run));
        let copyErrors = 0;
        for (const script of scripts) {
            if (!failedFiles.has(script.toLowerCase())) {
                copyErrors += this.copyOutputs(project, script);
            }
        }

        const ok = outcome.ok && copyErrors === 0;
        const counts = outcome.succeeded + outcome.failed > 0
            ? `${outcome.succeeded} succeeded, ${outcome.failed} failed`
            : `${scripts.length} scripts`;
        this.summary(ok, ok ? `Compiled ${path.basename(folder)}: ${counts}` : `Compile of ${path.basename(folder)} had errors: ${counts}`);
    }

    // ---- compiling -----------------------------------------------------------------------

    /** Compiles one script and copies its outputs. Plays no sound and shows no message. */
    private async compileFile(file: string): Promise<CompileOutcome> {
        this.output.appendLine(`Compiling ${path.basename(file)}`);
        const project = await this.findProject(file);
        if (!project) {
            return { ok: false, succeeded: 0, failed: 1 };
        }
        const exe = this.checkCompiler(project);
        if (!exe) {
            return { ok: false, succeeded: 0, failed: 1 };
        }
        this.output.appendLine(`Project: ${project.file}`);

        const scriptDir = path.dirname(file);
        const run = await this.run(exe, this.buildArgs(project, this.compileTarget(project, file), scriptDir, false), scriptDir);
        const outcome = this.evaluate(run, [file]);
        if (outcome.ok && this.copyOutputs(project, file) > 0) {
            return { ok: false, succeeded: 1, failed: 0 };
        }
        return outcome;
    }

    /** Builds the command line. Settings the .ppj doesn't have are left out. */
    private buildArgs(project: PpjProject, target: string, scriptDir: string, all: boolean): string[] {
        const c = project.compile;
        const args = [target];
        if (all) {
            args.push('-all');
            if (c.noRecurse) {
                args.push('-norecurse');
            }
        }
        const output = outputFolder(project);
        if (output) {
            args.push(`-output=${trimSeparator(output)}`);
        }

        const imports = project.folders.map(trimSeparator);
        if (!imports.some((f) => samePath(f, scriptDir))) {
            imports.push(trimSeparator(scriptDir));
        }
        args.push(`-import=${imports.join(';')}`);

        if (c.flags) {
            args.push(`-flags=${c.flags}`);
        }
        if (c.optimize) {
            args.push('-optimize');
        }
        if (c.debug) {
            args.push('-debug');
        }
        if (c.release) {
            args.push('-release');
        }
        if (c.final) {
            args.push('-final');
        }
        if (c.ignoreCwd) {
            args.push('-ignorecwd');
        }
        if (c.keepAsm) {
            args.push('-keepasm');
        }
        return args;
    }

    /**
     * Fallout 4 and Starfield scripts in subfolders have namespaces ("MyMod:MyScript"); those are
     * passed relative to their source folder ("MyMod\MyScript.psc") so the compiler sees the
     * namespace. Everything else is passed as a full path.
     */
    private compileTarget(project: PpjProject, file: string): string {
        if (!isNamespacedGame(project)) {
            return file;
        }
        const relative = relativeToSource(project, file);
        return relative && relative.includes(path.sep) ? relative : file;
    }

    private run(exe: string, args: string[], cwd: string): Promise<RunResult> {
        this.output.appendLine(`> "${exe}" ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
        return new Promise((resolve) => {
            cp.execFile(exe, args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
                const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
                if (err && typeof err.code !== 'number') {
                    // The compiler couldn't be started at all.
                    stderr = `${stderr}\n${err.message}`;
                }
                resolve({ code, stdout: String(stdout), stderr: String(stderr) });
            });
        });
    }

    /** Prints the compiler's output, updates the Problems panel and decides success. */
    private evaluate(run: RunResult, compiled: string[]): CompileOutcome {
        const text = `${run.stdout}\n${run.stderr}`;
        if (run.stdout.trim()) {
            this.output.appendLine(run.stdout.trimEnd());
        }
        if (run.stderr.trim()) {
            this.output.appendLine(run.stderr.trimEnd());
        }

        // Problems panel: clear the compiled files, then add what the compiler reported.
        for (const file of compiled) {
            this.diagnostics.delete(vscode.Uri.file(file));
        }
        const byFile = new Map<string, vscode.Diagnostic[]>();
        for (const line of text.split(/\r?\n/)) {
            const m = line.trim().match(errorLine);
            if (!m) {
                continue;
            }
            const file = path.normalize(m[1]);
            const lineNo = Math.max(0, Number(m[2]) - 1);
            const col = Math.max(0, Number(m[3]) - 1);
            const message = m[4];
            const severity = /^warning\b/i.test(message)
                ? vscode.DiagnosticSeverity.Warning
                : vscode.DiagnosticSeverity.Error;
            const diagnostic = new vscode.Diagnostic(new vscode.Range(lineNo, col, lineNo, col + 1), message, severity);
            diagnostic.source = 'Papyrus Compiler';
            const list = byFile.get(file) ?? [];
            list.push(diagnostic);
            byFile.set(file, list);
        }
        for (const [file, list] of byFile) {
            this.diagnostics.set(vscode.Uri.file(file), list);
        }

        const counts = text.match(/(\d+)\s+succeeded,\s*(\d+)\s+failed/i);
        const succeeded = counts ? Number(counts[1]) : 0;
        const failed = counts ? Number(counts[2]) : 0;
        const hasErrors = [...byFile.values()].some((l) => l.some((d) => d.severity === vscode.DiagnosticSeverity.Error));
        const ok = run.code === 0 && run.stderr.trim() === '' && failed === 0 && !hasErrors;
        return { ok, succeeded, failed };
    }

    /** Lower-case paths of the files the compiler reported errors in. */
    private diagnosticsFiles(run: RunResult): string[] {
        const result: string[] = [];
        for (const line of `${run.stdout}\n${run.stderr}`.split(/\r?\n/)) {
            const m = line.trim().match(errorLine);
            if (m && !/^warning\b/i.test(m[4])) {
                result.push(path.normalize(m[1]).toLowerCase());
            }
        }
        return result;
    }

    /** Copies the .pex and .psc to the .ppj's output folders. Returns the number of failures. */
    private copyOutputs(project: PpjProject, file: string): number {
        const c = project.compile;
        if (c.pexOutputFolders.length === 0 && c.pscOutputFolders.length === 0) {
            return 0;
        }
        const name = path.basename(file, path.extname(file));
        const relDir = isNamespacedGame(project) ? path.dirname(relativeToSource(project, file) ?? path.basename(file)) : '.';
        // With no output folder at all the compiler writes next to the script (it runs there).
        const outDir = outputFolder(project) ?? path.dirname(file);
        let pex = path.join(outDir, relDir, name + '.pex');
        if (!fs.existsSync(pex)) {
            pex = path.join(outDir, name + '.pex');
        }

        let errors = 0;
        const copy = (from: string, folder: string) => {
            const to = path.join(folder, relDir, path.basename(from));
            if (samePath(from, to)) {
                return;
            }
            try {
                fs.mkdirSync(path.dirname(to), { recursive: true });
                fs.copyFileSync(from, to);
                this.output.appendLine(`Copied ${path.basename(from)} to ${path.dirname(to)}`);
            } catch (e) {
                errors++;
                this.output.appendLine(`Failed to copy ${from} to ${to}: ${e instanceof Error ? e.message : String(e)}`);
            }
        };
        c.pexOutputFolders.forEach((folder) => copy(pex, folder));
        c.pscOutputFolders.forEach((folder) => copy(file, folder));
        return errors;
    }

    // ---- projects ------------------------------------------------------------------------

    /**
     * The .ppj for a script: .ppj files in its folder and parent folders (closest first; one that
     * lists the script's folder wins), then the workspace's .ppj files (one with a <Compiler> first).
     * Read fresh each time, so edits to the .ppj apply right away.
     */
    private async findProject(file: string): Promise<PpjProject | undefined> {
        const nearby: PpjProject[] = [];
        for (const ppj of await findPpjUpwards(path.dirname(file))) {
            const project = await readPpj(ppj);
            if (project) {
                nearby.push(project);
            }
        }
        const project =
            nearby.find((p) => relativeToSource(p, file) !== undefined) ??
            nearby[0] ??
            (await this.workspaceProject());
        if (!project) {
            this.output.appendLine(
                `No .ppj project found for ${file}. Put one in the script's folder or a parent folder, with a <Compiler> path.`
            );
            this.output.show(true);
        }
        return project;
    }

    private async workspaceProject(): Promise<PpjProject | undefined> {
        const known = this.index.projectList;
        const pick = known.find((p) => p.compile.compiler) ?? known[0];
        return pick ? ((await readPpj(pick.file)) ?? pick) : undefined;
    }

    private checkCompiler(project: PpjProject): string | undefined {
        const exe = project.compile.compiler;
        if (!exe) {
            this.output.appendLine(
                `${path.basename(project.file)} has no compiler. Add <Compiler>C:\\...\\Papyrus Compiler</Compiler> to it.`
            );
            this.output.show(true);
            return undefined;
        }
        if (!fs.existsSync(exe)) {
            this.output.appendLine(`Compiler not found: ${exe} (from ${project.file})`);
            this.output.show(true);
            return undefined;
        }
        return exe;
    }

    // ---- messages and sounds -------------------------------------------------------------

    private startOutput() {
        if (this.setting<boolean>('clearOutputBeforeCompiling', false)) {
            this.output.clear();
        } else {
            this.output.appendLine('\n-----------------------------------------------------------------------\n');
        }
        this.output.show(true);
    }

    private report(result: CompileOutcome, name: string, sound: boolean) {
        if (result.ok) {
            this.success(`${name} compiled successfully`, sound);
        } else {
            this.failure(`${name} failed to compile`, sound);
        }
    }

    private summary(ok: boolean, message: string) {
        if (ok) {
            this.success(message, true);
        } else {
            this.failure(message, true);
        }
    }

    private success(message: string, sound: boolean) {
        this.output.appendLine(message);
        if (!(sound && this.playSound('soundFileSuccess'))) {
            void vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: message },
                () => new Promise((resolve) => setTimeout(resolve, 4000))
            );
        }
    }

    private failure(message: string, sound: boolean) {
        this.output.appendLine(message);
        this.output.show(true);
        if (sound) {
            this.failSound();
        }
        void vscode.window.setStatusBarMessage(`$(error) ${message}`, 6000);
    }

    private failSound() {
        this.playSound('soundFileFail');
    }

    /** Plays a .wav from the settings. Returns false if there's no sound to play. */
    private playSound(key: string): boolean {
        const file = this.setting<string>(key, '').trim().replace(/^"(.*)"$/, '$1');
        if (!file || !fs.existsSync(file) || process.platform !== 'win32') {
            return false;
        }
        const script = `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync();`;
        cp.execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, () => {});
        return true;
    }

    /** A setting from the "Papyrus (Dylbill) - Compiler" section. */
    private setting<T>(key: string, fallback: T): T {
        return vscode.workspace.getConfiguration(section).get<T>(key) ?? fallback;
    }

    private async saveIfDirty(files: string[]) {
        const wanted = new Set(files.map((f) => f.toLowerCase()));
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.isDirty && wanted.has(doc.uri.fsPath.toLowerCase())) {
                const key = doc.uri.toString();
                this.savingForCompile.add(key);
                try {
                    await doc.save();
                } finally {
                    this.savingForCompile.delete(key);
                }
            }
        }
    }

    dispose() {
        this.disposables.forEach((d) => d.dispose());
    }
}

// ---- helpers -------------------------------------------------------------------------------

function isPsc(doc: vscode.TextDocument) {
    return doc.uri.scheme === 'file' && /\.psc$/i.test(doc.uri.fsPath);
}

function samePath(a: string, b: string) {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function trimSeparator(p: string) {
    return p.length > 3 ? p.replace(/[\\/]+$/, '') : p;
}

/** Where the compiler writes: Output, or else the first PexOutputFolders entry. */
function outputFolder(project: PpjProject): string | undefined {
    return project.compile.output ?? project.compile.pexOutputFolders[0];
}

function isNamespacedGame(project: PpjProject) {
    const game = project.compile.game;
    if (game) {
        return game === 'fo4' || game === 'sf1' || game === 'starfield';
    }
    const flags = (project.compile.flags ?? '').toLowerCase();
    return flags.includes('institute') || flags.includes('starfield');
}

/** The script's path relative to the first .ppj source folder containing it. */
function relativeToSource(project: PpjProject, file: string): string | undefined {
    const lower = path.resolve(file).toLowerCase();
    for (const folder of project.folders) {
        const prefix = trimSeparator(path.resolve(folder)).toLowerCase() + path.sep;
        if (lower.startsWith(prefix)) {
            return path.resolve(file).substring(prefix.length);
        }
    }
    return undefined;
}

function openPscTabs(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file') {
                const file = tab.input.uri.fsPath;
                if (/\.psc$/i.test(file) && !seen.has(file.toLowerCase())) {
                    seen.add(file.toLowerCase());
                    result.push(file);
                }
            }
        }
    }
    return result;
}

async function listPsc(folder: string, recursive: boolean): Promise<string[]> {
    try {
        const entries = await fs.promises.readdir(folder, { recursive, withFileTypes: false });
        return entries.map(String).filter((e) => /\.psc$/i.test(e)).map((e) => path.join(folder, e));
    } catch {
        return [];
    }
}
