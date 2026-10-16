import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectIndex } from './projectIndex';
import { type PapyrusSymbol, type ScriptInfo, parseScript, scopeAt } from './symbols';
import { isReservedWord } from './tokenizer';

/** A resolved name: a symbol in some script, or a whole script. */
type Target =
    | { kind: 'symbol'; symbol: PapyrusSymbol; file: string; script?: ScriptInfo }
    | { kind: 'script'; file: string; script: ScriptInfo };

const wordPattern = /[A-Za-z_]\w*(?::[A-Za-z_]\w*)*/;

/** Max depth when following "extends" (guards against loops). */
const maxInheritance = 32;

/**
 * Go to definition and hover, from a light scan of declarations (see symbols.ts).
 *
 * Lookup order for a name at the cursor:
 *  - "X.Name": the type of X (a variable/property's declared type, a script name, Self/Parent,
 *    or a function call's return type), then that script's parents.
 *  - "Name": locals and parameters of the enclosing function, then the current script and its
 *    parents, then scripts brought in with Import. A plain script name goes to the script.
 */
/** Keywords offered by autocomplete when not after a ".". */
const completionKeywords = [
    'Function', 'EndFunction', 'Event', 'EndEvent', 'Property', 'EndProperty', 'Auto', 'AutoReadOnly',
    'State', 'EndState', 'If', 'ElseIf', 'Else', 'EndIf', 'While', 'EndWhile', 'Return', 'Scriptname',
    'Extends', 'Import', 'Native', 'Global', 'Conditional', 'Hidden', 'Const', 'New', 'As', 'Is',
    'True', 'False', 'None', 'Self', 'Parent', 'Bool', 'Int', 'Float', 'String', 'Var', 'Struct', 'EndStruct',
    'Group', 'EndGroup', 'CustomEvent',
];

/** Max script names offered by autocomplete for a typed prefix. */
const maxScriptNameItems = 200;

export class PapyrusNavigation
    implements
        vscode.DefinitionProvider,
        vscode.HoverProvider,
        vscode.CompletionItemProvider,
        vscode.SignatureHelpProvider,
        vscode.Disposable
{
    private readonly fileCache = new Map<string, { mtime: number; info: ScriptInfo }>();
    private readonly docCache = new Map<string, { version: number; info: ScriptInfo }>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly index: ProjectIndex) {
        const selector: vscode.DocumentSelector = { language: 'papyrus' };
        this.disposables.push(
            vscode.languages.registerDefinitionProvider(selector, this),
            vscode.languages.registerHoverProvider(selector, this),
            vscode.languages.registerCompletionItemProvider(selector, this, '.'),
            vscode.languages.registerSignatureHelpProvider(selector, this, '(', ','),
            vscode.workspace.onDidCloseTextDocument((doc) => this.docCache.delete(doc.uri.toString()))
        );
    }

    provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Definition | undefined {
        const target = this.resolve(document, position);
        if (!target) {
            return undefined;
        }
        if (target.kind === 'script') {
            return new vscode.Location(
                vscode.Uri.file(target.file),
                new vscode.Position(target.script.nameLine, target.script.nameCharacter)
            );
        }
        return new vscode.Location(
            vscode.Uri.file(target.file),
            new vscode.Position(target.symbol.line, Math.max(0, target.symbol.character))
        );
    }

    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        const target = this.resolve(document, position);
        if (!target) {
            return undefined;
        }

        const md = new vscode.MarkdownString();
        if (target.kind === 'script') {
            const s = target.script;
            md.appendCodeblock(`Scriptname ${s.name ?? ''}${s.extends ? ' extends ' + s.extends : ''}`, 'papyrus');
            if (s.doc) {
                md.appendMarkdown('\n' + escapeMarkdown(s.doc) + '\n');
            }
            md.appendMarkdown(`\n\n*${escapeMarkdown(path.basename(target.file))}*`);
        } else {
            const sym = target.symbol;
            const isCallable = sym.kind === 'function' || sym.kind === 'event';
            const owner =
                sym.kind === 'variable' || sym.kind === 'parameter'
                    ? undefined
                    : target.script?.name ?? path.basename(target.file, '.psc');
            const what = sym.kind === 'customevent' ? 'custom event' : sym.kind;

            if (isCallable) {
                // Short header; the full definition goes at the bottom.
                md.appendMarkdown(`**${escapeMarkdown(sym.name)}** — *${what}${owner ? ' in ' + escapeMarkdown(owner) : ''}*\n`);
            } else {
                md.appendCodeblock(sym.signature, 'papyrus');
            }
            if (sym.doc) {
                md.appendMarkdown('\n' + escapeMarkdown(sym.doc) + '\n');
            }
            if (sym.params && sym.params.length > 0) {
                md.appendMarkdown('\n\n**Parameters**\n');
                for (const p of sym.params) {
                    const def = p.defaultValue !== undefined ? ` = ${p.defaultValue}` : '';
                    md.appendMarkdown(`\n- \`${p.type} ${p.name}${def}\``);
                }
                md.appendMarkdown('\n');
            }
            if (isCallable && sym.type) {
                md.appendMarkdown(`\n\n**Returns** \`${sym.type}\``);
            }
            if (isCallable) {
                md.appendMarkdown('\n\n');
                md.appendCodeblock(sym.signature, 'papyrus');
            } else {
                md.appendMarkdown(`\n\n*${what}${owner ? ' in ' + escapeMarkdown(owner) : ''}*`);
            }
        }

        const range = document.getWordRangeAtPosition(position, wordPattern);
        return new vscode.Hover(md, range);
    }

    // ---- autocomplete --------------------------------------------------------------------

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionList | undefined {
        const lineText = document.lineAt(position.line).text;
        const before = lineText.substring(0, position.character);
        if (isInCommentOrString(lineText, position.character)) {
            return undefined;
        }

        const prefixMatch = before.match(/[A-Za-z_]\w*$/);
        const prefix = prefixMatch ? prefixMatch[0] : '';
        const beforePrefix = before.substring(0, before.length - prefix.length);
        const callFollows = /^\s*\(/.test(lineText.substring(position.character));
        const current = this.documentInfo(document);
        const dir = path.dirname(document.uri.fsPath);
        const items = new Map<string, vscode.CompletionItem>();
        const add = (item: vscode.CompletionItem) => {
            const key = (typeof item.label === 'string' ? item.label : item.label.label).toLowerCase();
            if (!items.has(key)) {
                items.set(key, item);
            }
        };

        // "Event On|" : the events this script can handle, inserted as a full definition.
        if (/^\s*event\s+$/i.test(beforePrefix)) {
            let own = true;
            for (const { info } of this.chainFrom(current, dir)) {
                for (const sym of info.members.values()) {
                    // Skip events already defined in this script.
                    if (sym.kind === 'event' && !own) {
                        add(this.eventDefinitionItem(sym, info));
                    }
                }
                own = false;
            }
            const defined = new Set(
                [...current.members.values()].filter((m) => m.kind === 'event').map((m) => m.name.toLowerCase())
            );
            return new vscode.CompletionList(
                [...items.values()].filter((i) => !defined.has((i.label as vscode.CompletionItemLabel).label.toLowerCase())),
                false
            );
        }

        // "X." : members of X's type, or global functions of script X
        const dot = beforePrefix.match(/\.\s*$/);
        if (dot) {
            const qualifier = beforePrefix.substring(0, beforePrefix.length - dot[0].length);
            const target = this.qualifierType(qualifier, current, position.line, dir);
            if (!target) {
                return undefined;
            }
            for (const { info } of this.chain(target.type, dir)) {
                for (const sym of info.members.values()) {
                    if (target.isStatic) {
                        if (sym.kind === 'function' && sym.global) {
                            add(this.completionItem(sym, info, callFollows));
                        }
                    } else if ((sym.kind === 'function' && !sym.global) || sym.kind === 'property') {
                        add(this.completionItem(sym, info, callFollows));
                    }
                }
                // Global functions are called on the script itself, not inherited.
                if (target.isStatic) {
                    break;
                }
            }
            return new vscode.CompletionList([...items.values()], false);
        }

        // Locals and parameters in the enclosing function
        const scope = scopeAt(current, position.line);
        if (scope) {
            for (const local of scope.locals) {
                if (local.line < position.line) {
                    add(this.completionItem(local, current, callFollows));
                }
            }
            scope.parameters.forEach((p) => add(this.completionItem(p, current, callFollows)));
        }

        // The current script and the scripts it extends (their variables are private)
        let first = true;
        for (const { info } of this.chainFrom(current, dir)) {
            for (const sym of info.members.values()) {
                if (sym.kind !== 'variable' || first) {
                    add(this.completionItem(sym, info, callFollows));
                }
            }
            first = false;
        }

        // Global functions from imported scripts
        for (const imported of current.imports) {
            const file = this.findScriptFile(imported, dir);
            const info = file ? this.fileInfo(file) : undefined;
            for (const sym of info?.members.values() ?? []) {
                if (sym.kind === 'function' && sym.global) {
                    add(this.completionItem(sym, info!, callFollows));
                }
            }
        }

        for (const keyword of completionKeywords) {
            const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
            add(item);
        }

        // Script names: there can be thousands, so only offer those matching what's typed.
        let incomplete = false;
        if (prefix.length > 0) {
            const names = this.index.scriptNamesStartingWith(prefix, maxScriptNameItems);
            for (const name of names) {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
                item.detail = 'Script';
                add(item);
            }
            incomplete = true; // ask again as the prefix grows
        }

        return new vscode.CompletionList([...items.values()], incomplete);
    }

    private completionItem(sym: PapyrusSymbol, owner: ScriptInfo, callFollows: boolean): vscode.CompletionItem {
        const kinds: Record<string, vscode.CompletionItemKind> = {
            function: vscode.CompletionItemKind.Function,
            event: vscode.CompletionItemKind.Event,
            property: vscode.CompletionItemKind.Property,
            variable: vscode.CompletionItemKind.Variable,
            parameter: vscode.CompletionItemKind.Variable,
            state: vscode.CompletionItemKind.EnumMember,
            struct: vscode.CompletionItemKind.Struct,
            customevent: vscode.CompletionItemKind.Event,
        };
        const item = new vscode.CompletionItem(
            { label: sym.name, description: owner.name },
            kinds[sym.kind] ?? vscode.CompletionItemKind.Text
        );
        item.detail = sym.signature;
        if (sym.doc) {
            item.documentation = new vscode.MarkdownString(escapeMarkdown(sym.doc));
        }

        if ((sym.kind === 'function' || sym.kind === 'event') && !callFollows) {
            // Insert "Name(" + parameter placeholders + ")"; Tab moves between them.
            const snippet = new vscode.SnippetString(sym.name + '(');
            const required = (sym.params ?? []).filter((p) => p.defaultValue === undefined);
            required.forEach((p, i) => {
                if (i > 0) {
                    snippet.appendText(', ');
                }
                snippet.appendPlaceholder(p.name);
            });
            snippet.appendText(')');
            item.insertText = snippet;
            item.command = { command: 'editor.action.triggerParameterHints', title: 'Parameter hints' };
        }
        return item;
    }

    /** "OnActivate(ObjectReference akActionRef)" + an empty body + "EndEvent". */
    private eventDefinitionItem(sym: PapyrusSymbol, owner: ScriptInfo): vscode.CompletionItem {
        const item = new vscode.CompletionItem(
            { label: sym.name, description: owner.name },
            vscode.CompletionItemKind.Event
        );
        item.detail = sym.signature;
        if (sym.doc) {
            item.documentation = new vscode.MarkdownString(escapeMarkdown(sym.doc));
        }
        const params = (sym.params ?? []).map((p) => p.text).join(', ');
        // Snippet lines after the first get the current line's indentation automatically.
        const snippet = new vscode.SnippetString();
        snippet.appendText(`${sym.name}(${params})\n\t`);
        snippet.appendTabstop(0);
        snippet.appendText('\nEndEvent');
        item.insertText = snippet;
        return item;
    }

    // ---- parameter hints -------------------------------------------------------------------

    provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position): vscode.SignatureHelp | undefined {
        const lineText = document.lineAt(position.line).text;
        const before = lineText.substring(0, position.character);

        // Find the "(" of the call the cursor is in, counting commas at that level.
        let depth = 0;
        let commas = 0;
        let open = -1;
        let inString = false;
        for (let i = before.length - 1; i >= 0; i--) {
            const c = before[i];
            if (c === '"') {
                // Walk back over a string (escaped quotes are rare enough to ignore here).
                inString = !inString;
                continue;
            }
            if (inString) {
                continue;
            }
            if (c === ')' || c === ']') {
                depth++;
            } else if (c === '(' || c === '[') {
                if (depth === 0) {
                    if (c === '(') {
                        open = i;
                    }
                    break;
                }
                depth--;
            } else if (c === ',' && depth === 0) {
                commas++;
            }
        }
        if (open < 0) {
            return undefined;
        }

        const nameMatch = before.substring(0, open).match(/([A-Za-z_]\w*)\s*$/);
        if (!nameMatch) {
            return undefined;
        }
        const nameStart = open - nameMatch[0].length;
        const target = this.resolve(document, new vscode.Position(position.line, nameStart));
        if (!target || target.kind !== 'symbol' || !target.symbol.params) {
            return undefined;
        }

        const sym = target.symbol;
        const params = target.symbol.params;
        const label = sym.signature;
        const info = new vscode.SignatureInformation(label, sym.doc ? new vscode.MarkdownString(escapeMarkdown(sym.doc)) : undefined);
        let searchFrom = label.indexOf('(') + 1;
        for (const p of params) {
            const start = label.indexOf(p.text, searchFrom);
            if (start >= 0) {
                info.parameters.push(new vscode.ParameterInformation([start, start + p.text.length]));
                searchFrom = start + p.text.length;
            } else {
                info.parameters.push(new vscode.ParameterInformation(p.text));
            }
        }

        const help = new vscode.SignatureHelp();
        help.signatures = [info];
        help.activeSignature = 0;
        help.activeParameter = Math.min(commas, Math.max(0, params.length - 1));
        return help;
    }

    // ---- resolution ---------------------------------------------------------------------

    private resolve(document: vscode.TextDocument, position: vscode.Position): Target | undefined {
        const range = document.getWordRangeAtPosition(position, wordPattern);
        if (!range) {
            return undefined;
        }

        const lineText = document.lineAt(position.line).text;
        if (isInCommentOrString(lineText, range.start.character)) {
            return undefined;
        }

        const word = document.getText(range);
        const isCall = /^\s*\(/.test(lineText.substring(range.end.character));
        const before = lineText.substring(0, range.start.character);
        const current = this.documentInfo(document);
        const currentFile = document.uri.fsPath;
        const dir = path.dirname(currentFile);

        // Qualified: X.Word
        const dot = before.match(/\.\s*$/);
        if (dot) {
            const qualifierText = before.substring(0, before.length - dot[0].length);
            const typeName = this.expressionType(qualifierText, current, position.line, dir);
            if (!typeName) {
                return undefined;
            }
            return this.findMember(typeName, word, dir, isCall);
        }

        const lower = word.toLowerCase();

        if (!isCall) {
            // Locals and parameters of the enclosing function
            const scope = scopeAt(current, position.line);
            if (scope) {
                const local =
                    scope.locals.find((l) => l.name.toLowerCase() === lower && l.line <= position.line) ??
                    scope.parameters.find((p) => p.name.toLowerCase() === lower);
                if (local) {
                    return { kind: 'symbol', symbol: local, file: currentFile, script: current };
                }
            }
        }

        // The current script and its parents
        const inherited = this.findInChain(current, currentFile, lower, dir, isCall);
        if (inherited) {
            return inherited;
        }

        if (isCall) {
            // Global functions from imported scripts
            for (const imported of current.imports) {
                const found = this.findMember(imported, word, dir, true);
                if (found) {
                    return found;
                }
            }
            return undefined;
        }

        // A script name
        const scriptFile = this.findScriptFile(word, dir);
        if (scriptFile) {
            const script = this.fileInfo(scriptFile);
            if (script) {
                return { kind: 'script', file: scriptFile, script };
            }
        }

        return undefined;
    }

    /** Finds `name` in a script (by name) or its parents. */
    private findMember(scriptName: string, name: string, dir: string, isCall: boolean): Target | undefined {
        const file = this.findScriptFile(scriptName, dir);
        const info = file ? this.fileInfo(file) : undefined;
        if (!file || !info) {
            return undefined;
        }
        return this.findInChain(info, file, name.toLowerCase(), dir, isCall);
    }

    /** Looks for `lower` in `info` and then up its "extends" chain. */
    private findInChain(info: ScriptInfo, file: string, lower: string, dir: string, isCall: boolean): Target | undefined {
        let currentInfo: ScriptInfo | undefined = info;
        let currentFile: string | undefined = file;
        const seen = new Set<string>();

        for (let depth = 0; currentInfo && currentFile && depth < maxInheritance; depth++) {
            const key = currentFile.toLowerCase();
            if (seen.has(key)) {
                break;
            }
            seen.add(key);

            const sym = currentInfo.members.get(lower);
            if (sym && isCall === (sym.kind === 'function' || sym.kind === 'event')) {
                return { kind: 'symbol', symbol: sym, file: currentFile, script: currentInfo };
            }

            if (!currentInfo.extends) {
                break;
            }
            currentFile = this.findScriptFile(currentInfo.extends, dir);
            currentInfo = currentFile ? this.fileInfo(currentFile) : undefined;
        }
        return undefined;
    }

    /**
     * The script type of the expression right before a ".": a variable, property, parameter,
     * Self/Parent, a script name, or a call (its return type). Array types aren't followed.
     */
    private expressionType(text: string, current: ScriptInfo, line: number, dir: string): string | undefined {
        const trimmed = text.trimEnd();

        // A call: Foo(...) or X.Foo(...)
        if (trimmed.endsWith(')')) {
            const open = matchingOpenParen(trimmed);
            if (open < 0) {
                return undefined;
            }
            const head = trimmed.substring(0, open);
            const nameMatch = head.match(/([A-Za-z_]\w*)\s*$/);
            if (!nameMatch) {
                return undefined;
            }
            const fnName = nameMatch[1];
            const headBefore = head.substring(0, head.length - nameMatch[0].length);
            const headDot = headBefore.match(/\.\s*$/);

            let fn: Target | undefined;
            if (headDot) {
                const ownerType = this.expressionType(
                    headBefore.substring(0, headBefore.length - headDot[0].length),
                    current,
                    line,
                    dir
                );
                fn = ownerType ? this.findMember(ownerType, fnName, dir, true) : undefined;
            } else {
                fn = this.findInChainByScript(current, fnName, dir);
            }
            return fn?.kind === 'symbol' ? stripArray(fn.symbol.type) : undefined;
        }

        const nameMatch = trimmed.match(/([A-Za-z_]\w*(?::[A-Za-z_]\w*)*)$/);
        if (!nameMatch) {
            return undefined;
        }
        const name = nameMatch[1];
        const lower = name.toLowerCase();

        if (lower === 'self') {
            return current.name;
        }
        if (lower === 'parent') {
            return current.extends;
        }

        // A local, parameter, or member variable/property (including inherited ones)
        const scope = scopeAt(current, line);
        const local =
            scope?.locals.find((l) => l.name.toLowerCase() === lower) ??
            scope?.parameters.find((p) => p.name.toLowerCase() === lower);
        if (local) {
            return stripArray(local.type);
        }
        const member = this.findInChain(current, '<current>', lower, dir, false);
        if (member?.kind === 'symbol' && member.symbol.type) {
            return stripArray(member.symbol.type);
        }

        // Otherwise a script name (a static call like Debug.Trace)
        return this.findScriptFile(name, dir) ? name : undefined;
    }

    /** A function in the current script, its parents, or imported scripts. */
    private findInChainByScript(current: ScriptInfo, fnName: string, dir: string): Target | undefined {
        const found = this.findInChain(current, '<current>', fnName.toLowerCase(), dir, true);
        if (found) {
            return found;
        }
        for (const imported of current.imports) {
            const viaImport = this.findMember(imported, fnName, dir, true);
            if (viaImport) {
                return viaImport;
            }
        }
        return undefined;
    }

    /**
     * The type in front of a "." and whether it's a static script reference (Debug.) rather
     * than a value (MyActor., Self., Game.GetPlayer().).
     */
    private qualifierType(
        text: string,
        current: ScriptInfo,
        line: number,
        dir: string
    ): { type: string; isStatic: boolean } | undefined {
        const trimmed = text.trimEnd();
        const simple = trimmed.match(/(?:^|[^\w.:])([A-Za-z_]\w*(?::[A-Za-z_]\w*)*)$/);
        if (simple && !trimmed.endsWith(')')) {
            const name = simple[1];
            const lower = name.toLowerCase();
            const isValue =
                lower === 'self' ||
                lower === 'parent' ||
                this.isVariableInScope(lower, current, line, dir);
            if (!isValue && !isReservedWord(lower) && this.findScriptFile(name, dir)) {
                return { type: name, isStatic: true };
            }
        }
        const type = this.expressionType(text, current, line, dir);
        return type ? { type, isStatic: false } : undefined;
    }

    private isVariableInScope(lower: string, current: ScriptInfo, line: number, dir: string): boolean {
        const scope = scopeAt(current, line);
        if (
            scope?.locals.some((l) => l.name.toLowerCase() === lower) ||
            scope?.parameters.some((p) => p.name.toLowerCase() === lower)
        ) {
            return true;
        }
        const member = this.findInChain(current, '<current>', lower, dir, false);
        return member?.kind === 'symbol' && (member.symbol.kind === 'property' || member.symbol.kind === 'variable');
    }

    /** A script (by name) followed by the scripts it extends. */
    private *chain(scriptName: string, dir: string): Generator<{ info: ScriptInfo; file: string }> {
        const file = this.findScriptFile(scriptName, dir);
        const info = file ? this.fileInfo(file) : undefined;
        if (file && info) {
            yield { info, file };
            yield* this.chainFrom(info, dir, file);
        }
    }

    /** The scripts `info` extends, starting with `info` itself when `startFile` isn't given. */
    private *chainFrom(info: ScriptInfo, dir: string, startFile?: string): Generator<{ info: ScriptInfo; file: string }> {
        const seen = new Set<string>();
        let currentInfo: ScriptInfo | undefined = info;
        let currentFile: string | undefined = startFile ?? '<current>';
        if (!startFile) {
            yield { info, file: currentFile };
        }
        seen.add(currentFile.toLowerCase());
        for (let depth = 0; currentInfo?.extends && depth < maxInheritance; depth++) {
            currentFile = this.findScriptFile(currentInfo.extends, dir);
            if (!currentFile || seen.has(currentFile.toLowerCase())) {
                return;
            }
            seen.add(currentFile.toLowerCase());
            currentInfo = this.fileInfo(currentFile);
            if (!currentInfo) {
                return;
            }
            yield { info: currentInfo, file: currentFile };
        }
    }

    // ---- files ---------------------------------------------------------------------------

    /** A script's .psc: from the .ppj source folders, else next to the current file. */
    private findScriptFile(name: string, dir: string): string | undefined {
        const indexed = this.index.findScript(name);
        if (indexed) {
            return indexed;
        }
        const local = path.join(dir, name.replace(/:/g, path.sep) + '.psc');
        return fs.existsSync(local) ? local : undefined;
    }

    private documentInfo(document: vscode.TextDocument): ScriptInfo {
        const key = document.uri.toString();
        const cached = this.docCache.get(key);
        if (cached && cached.version === document.version) {
            return cached.info;
        }
        const info = parseScript(document.getText());
        this.docCache.set(key, { version: document.version, info });
        return info;
    }

    /** Parsed declarations of a .psc; uses the open editor's text when the file is open. */
    private fileInfo(file: string): ScriptInfo | undefined {
        const open = vscode.workspace.textDocuments.find(
            (d) => d.uri.scheme === 'file' && d.uri.fsPath.toLowerCase() === file.toLowerCase()
        );
        if (open) {
            return this.documentInfo(open);
        }

        try {
            const mtime = fs.statSync(file).mtimeMs;
            const cached = this.fileCache.get(file);
            if (cached && cached.mtime === mtime) {
                return cached.info;
            }
            const info = parseScript(fs.readFileSync(file, 'utf8'));
            this.fileCache.set(file, { mtime, info });
            return info;
        } catch {
            return undefined;
        }
    }

    dispose() {
        this.disposables.forEach((d) => d.dispose());
    }
}

function stripArray(type: string | undefined): string | undefined {
    if (!type || type.endsWith('[]')) {
        return undefined;
    }
    return type;
}

/** Index of the "(" matching the ")" that ends `text`, or -1. */
function matchingOpenParen(text: string): number {
    let depth = 0;
    for (let i = text.length - 1; i >= 0; i--) {
        const c = text[i];
        if (c === ')') {
            depth++;
        } else if (c === '(') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

/** Rough check so hovering inside a ; comment or "string" does nothing. */
function isInCommentOrString(line: string, column: number): boolean {
    let inString = false;
    for (let i = 0; i < column && i < line.length; i++) {
        const c = line[i];
        if (inString) {
            if (c === '\\') {
                i++;
            } else if (c === '"') {
                inString = false;
            }
        } else if (c === '"') {
            inString = true;
        } else if (c === ';' || c === '{') {
            return true;
        }
    }
    return inString;
}

function escapeMarkdown(text: string) {
    return text.replace(/([\\`*_[\]<>])/g, '\\$1');
}
