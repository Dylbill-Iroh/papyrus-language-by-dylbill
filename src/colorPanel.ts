import * as vscode from 'vscode';
import { colorSettings, colorsSection } from './colorSettings';
import { readColor } from './colors';

const hexColor = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function makeNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

/**
 * "Papyrus: Customize Colors": a color picker for every color setting. VS Code's Settings page only
 * shows text boxes for color settings, so this gives a visual way to edit them.
 */
export class ColorPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private panelDisposables: vscode.Disposable[] = [];
    private readonly command: vscode.Disposable;

    constructor() {
        this.command = vscode.commands.registerCommand('dylbillPapyrus.customizeColors', () => this.show());
    }

    show() {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        this.panel = vscode.window.createWebviewPanel('dylbillPapyrusColors', 'Papyrus Colors', vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        this.panel.webview.html = this.html();

        this.panelDisposables.push(
            this.panel.onDidDispose(() => {
                this.panel = undefined;
                this.panelDisposables.forEach((d) => d.dispose());
                this.panelDisposables = [];
            }),
            this.panel.webview.onDidReceiveMessage((message) => this.onMessage(message)),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration(colorsSection)) {
                    void this.panel?.webview.postMessage({ type: 'values', settings: this.state() });
                }
            })
        );
    }

    private async onMessage(message: { type: string; key?: string; value?: string }) {
        const config = vscode.workspace.getConfiguration(colorsSection);
        switch (message.type) {
            case 'set':
                if (message.key && message.value && hexColor.test(message.value)) {
                    await config.update(message.key, message.value.toUpperCase(), vscode.ConfigurationTarget.Global);
                }
                break;
            case 'reset':
                if (message.key) {
                    await vscode.commands.executeCommand('dylbillPapyrus.resetColors', message.key);
                }
                break;
            case 'resetAll':
                await vscode.commands.executeCommand('dylbillPapyrus.resetColors');
                break;
            case 'enabled':
                await config.update('enabled', message.value === 'true', vscode.ConfigurationTarget.Global);
                break;
            case 'openSettings':
                await vscode.commands.executeCommand('workbench.action.openSettings', colorsSection);
                break;
        }
    }

    private state() {
        const config = vscode.workspace.getConfiguration(colorsSection);
        return {
            enabled: config.get<boolean>('enabled', true),
            colors: colorSettings.map((s) => ({
                key: s.key,
                title: s.title,
                description: s.description,
                sample: s.sample,
                group: s.group,
                value: readColor(s.key) ?? '#FFFFFF',
                defaultValue: config.inspect<string>(s.key)?.defaultValue ?? '',
            })),
        };
    }

    private html() {
        const nonce = makeNonce();
        const initial = JSON.stringify(this.state()).replace(/</g, '\\u003c');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Papyrus Colors</title>
<style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 20px 40px; max-width: 900px; }
    h1 { font-weight: 600; font-size: 1.6em; margin: 20px 0 4px; }
    h2 { font-weight: 600; font-size: 1.15em; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); }
    .sub { color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
    .toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
    .row { display: grid; grid-template-columns: 34px minmax(150px, 230px) 1fr auto; gap: 12px; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.15)); }
    .row.disabled { opacity: .5; }
    input[type=color] { width: 34px; height: 26px; padding: 0; border: 1px solid var(--vscode-input-border, #555); background: none; cursor: pointer; }
    .name { font-weight: 600; }
    .desc { color: var(--vscode-descriptionForeground); font-size: .92em; margin-top: 2px; }
    .sample { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); background: var(--vscode-editor-background); padding: 4px 10px; border-radius: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .controls { display: flex; gap: 8px; align-items: center; }
    input[type=text] { width: 92px; font-family: var(--vscode-editor-font-family); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; }
    input[type=text].invalid { border-color: var(--vscode-inputValidation-errorBorder, #f44); }
    button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; cursor: pointer; border-radius: 2px; }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity: .4; cursor: default; }
    a { color: var(--vscode-textLink-foreground); cursor: pointer; }
    @media (max-width: 640px) { .row { grid-template-columns: 34px 1fr; } .sample, .controls { grid-column: 1 / -1; } }
</style>
</head>
<body>
<h1>Papyrus Colors</h1>
<div class="sub">Pick a color and it's applied to Papyrus files right away. The text box accepts <code>#RRGGBB</code> or <code>#RRGGBBAA</code> (with transparency).</div>
<div class="toolbar">
    <label><input type="checkbox" id="enabled"> Apply Papyrus colors (off = use your theme's colors)</label>
    <button id="resetAll">Restore all defaults</button>
    <a id="openSettings">Open in Settings</a>
</div>
<div id="groups"></div>
<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initial = ${initial};
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
    const rows = {};

    // <input type=color> only understands #rrggbb; any alpha is kept from the text box.
    function toPickerValue(value) {
        let v = value.replace('#', '');
        if (v.length === 3 || v.length === 4) { v = v.split('').map(c => c + c).join(''); }
        return '#' + v.substring(0, 6).toLowerCase();
    }
    function alphaOf(value) {
        const v = value.replace('#', '');
        if (v.length === 4) { return (v[3] + v[3]).toUpperCase(); }
        if (v.length === 8) { return v.substring(6).toUpperCase(); }
        return '';
    }

    function setRow(row, setting) {
        row.setting = setting;
        row.picker.value = toPickerValue(setting.value);
        if (document.activeElement !== row.text) { row.text.value = setting.value.toUpperCase(); }
        row.text.classList.remove('invalid');
        row.sample.style.color = setting.value;
        row.reset.disabled = setting.value.toUpperCase() === String(setting.defaultValue).toUpperCase();
    }

    function build(settings) {
        const container = document.getElementById('groups');
        const groups = [];
        for (const s of settings.colors) {
            let g = groups.find(x => x.title === s.group);
            if (!g) { g = { title: s.group, items: [] }; groups.push(g); }
            g.items.push(s);
        }
        for (const group of groups) {
            const h = document.createElement('h2');
            h.textContent = group.title;
            container.appendChild(h);
            for (const s of group.items) {
                const row = document.createElement('div');
                row.className = 'row';
                const picker = document.createElement('input');
                picker.type = 'color';
                picker.title = 'Pick a color';
                const label = document.createElement('div');
                const name = document.createElement('div');
                name.className = 'name';
                name.textContent = s.title;
                const desc = document.createElement('div');
                desc.className = 'desc';
                desc.textContent = s.description;
                label.append(name, desc);
                const sample = document.createElement('div');
                sample.className = 'sample';
                sample.textContent = s.sample;
                const controls = document.createElement('div');
                controls.className = 'controls';
                const text = document.createElement('input');
                text.type = 'text';
                text.spellcheck = false;
                const reset = document.createElement('button');
                reset.textContent = 'Restore default';
                controls.append(text, reset);
                row.append(picker, label, sample, controls);
                container.appendChild(row);

                const r = { picker, text, sample, reset, row };
                rows[s.key] = r;
                picker.addEventListener('input', () => {
                    const value = picker.value.toUpperCase() + alphaOf(r.setting.value);
                    text.value = value;
                    sample.style.color = value;
                });
                picker.addEventListener('change', () => {
                    vscode.postMessage({ type: 'set', key: s.key, value: picker.value + alphaOf(r.setting.value) });
                });
                text.addEventListener('change', () => {
                    const value = text.value.trim();
                    if (!hex.test(value)) { text.classList.add('invalid'); return; }
                    vscode.postMessage({ type: 'set', key: s.key, value });
                });
                reset.addEventListener('click', () => vscode.postMessage({ type: 'reset', key: s.key }));
            }
        }
    }

    function render(settings) {
        document.getElementById('enabled').checked = settings.enabled;
        if (!Object.keys(rows).length) { build(settings); }
        for (const s of settings.colors) {
            const r = rows[s.key];
            if (r) { setRow(r, s); r.row.classList.toggle('disabled', !settings.enabled); }
        }
    }

    document.getElementById('enabled').addEventListener('change', (e) => {
        vscode.postMessage({ type: 'enabled', value: String(e.target.checked) });
    });
    document.getElementById('resetAll').addEventListener('click', () => vscode.postMessage({ type: 'resetAll' }));
    document.getElementById('openSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'values') { render(event.data.settings); }
    });

    render(initial);
</script>
</body>
</html>`;
    }

    dispose() {
        this.command.dispose();
        this.panel?.dispose();
    }
}
