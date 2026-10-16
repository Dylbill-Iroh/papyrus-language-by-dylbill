import * as vscode from 'vscode';
import { colorSettings, colorsSection } from './colorSettings';

const lastWrittenKey = 'dylbillPapyrus.lastWrittenColorRules';
const hexColor = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

interface SemanticColorCustomizations {
    rules?: { [selector: string]: unknown };
    [key: string]: unknown;
}

function colorsEnabled() {
    return vscode.workspace.getConfiguration(colorsSection).get<boolean>('enabled', true);
}

/** The configured color, or the package.json default if the value isn't a valid hex color. */
export function readColor(key: string): string | undefined {
    const config = vscode.workspace.getConfiguration(colorsSection);
    const value = (config.get<string>(key) ?? '').trim();
    if (hexColor.test(value)) {
        return value;
    }
    const fallback = (config.inspect<string>(key)?.defaultValue ?? '').trim();
    return hexColor.test(fallback) ? fallback : undefined;
}

export function selectorFor(tokenType: string) {
    return `${tokenType}:papyrus`;
}

/**
 * VS Code has no API for setting token colors directly, so the dylbillPapyrus.colors.* settings
 * are mirrored into the user's editor.semanticTokenColorCustomizations. Only the rules this
 * extension wrote are ever changed or removed.
 */
export class ColorSync implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private queue: Promise<void> = Promise.resolve();

    constructor(private readonly context: vscode.ExtensionContext) {
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration(colorsSection)) {
                    this.sync();
                }
            }),
            vscode.commands.registerCommand('dylbillPapyrus.resetColors', (key?: string) =>
                this.reset(typeof key === 'string' ? [key] : colorSettings.map((c) => c.key))
            )
        );
        this.sync();
    }

    sync() {
        this.queue = this.queue
            .then(() => this.write())
            .catch((err) => {
                void vscode.window.showWarningMessage(`Papyrus: couldn't apply color settings: ${err}`);
            });
    }

    async reset(keys: string[]) {
        const config = vscode.workspace.getConfiguration(colorsSection);
        for (const key of keys) {
            const inspected = config.inspect(key);
            if (inspected?.globalValue !== undefined) {
                await config.update(key, undefined, vscode.ConfigurationTarget.Global);
            }
            if (inspected?.workspaceValue !== undefined) {
                await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
            }
            if (inspected?.workspaceFolderValue !== undefined) {
                await config.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
            }
        }
    }

    private async write() {
        const enabled = colorsEnabled();
        const editor = vscode.workspace.getConfiguration('editor');
        const current =
            (editor.inspect<SemanticColorCustomizations>('semanticTokenColorCustomizations')?.globalValue as
                | SemanticColorCustomizations
                | undefined) ?? {};
        const lastWritten = this.context.globalState.get<{ [selector: string]: string }>(lastWrittenKey, {});

        const rules: { [selector: string]: unknown } = { ...(current.rules ?? {}) };
        const written: { [selector: string]: string } = {};

        for (const setting of colorSettings) {
            const selector = selectorFor(setting.tokenType);
            const color = enabled ? readColor(setting.key) : undefined;
            if (color) {
                rules[selector] = color;
                written[selector] = color;
            } else if (selector in lastWritten && rules[selector] === lastWritten[selector]) {
                delete rules[selector];
            }
        }

        const updated: SemanticColorCustomizations = { ...current, rules };
        if (Object.keys(rules).length === 0) {
            delete updated.rules;
        }

        if (JSON.stringify(updated) !== JSON.stringify(current)) {
            await editor.update(
                'semanticTokenColorCustomizations',
                Object.keys(updated).length === 0 ? undefined : updated,
                vscode.ConfigurationTarget.Global
            );
        }
        await this.context.globalState.update(lastWrittenKey, written);
    }

    dispose() {
        this.disposables.forEach((d) => d.dispose());
    }
}
