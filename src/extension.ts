import * as vscode from 'vscode';
import { ProjectIndex } from './projectIndex';
import { PapyrusSemanticTokens } from './semanticTokens';
import { PapyrusNavigation } from './navigation';
import { ColorSync } from './colors';
import { ColorPanel } from './colorPanel';
import { PapyrusCompiler } from './compiler';

export function activate(context: vscode.ExtensionContext) {
    const log = vscode.window.createOutputChannel('Papyrus (Dylbill)');
    const index = new ProjectIndex(log);

    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    status.command = 'dylbillPapyrus.showProjects';
    const updateStatus = () => {
        const projects = index.projectList.length;
        status.text = `$(file-code) Papyrus: ${index.scriptCount} scripts`;
        status.tooltip = projects
            ? `${projects} .ppj project(s). Click to see the source folders.`
            : 'No .ppj project found. Script names and go to definition need a .ppj with <Imports>/<Folders>.';
    };
    const updateStatusVisibility = () => {
        if (vscode.window.activeTextEditor?.document.languageId === 'papyrus') {
            status.show();
        } else {
            status.hide();
        }
    };

    context.subscriptions.push(
        log,
        index,
        status,
        new PapyrusSemanticTokens(index),
        new PapyrusNavigation(index),
        new ColorSync(context),
        new ColorPanel(),
        new PapyrusCompiler(index),
        index.onDidChange(updateStatus),
        vscode.window.onDidChangeActiveTextEditor(updateStatusVisibility),
        vscode.commands.registerCommand('dylbillPapyrus.showProjects', () => {
            log.appendLine('');
            log.appendLine('Projects in use:');
            for (const project of index.projectList) {
                log.appendLine(`  ${project.file}`);
                project.folders.forEach((f) => log.appendLine(`    ${f}`));
                log.appendLine(`    Compiler: ${project.compile.compiler ?? '(not set)'}`);
            }
            log.show(true);
        })
    );

    updateStatus();
    updateStatusVisibility();
    void index.initialize().then(updateStatus);
}

export function deactivate() {}
