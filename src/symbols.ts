/**
 * Lightweight Papyrus declaration scanner, used for go to definition and hover.
 * No VS Code dependencies, so it can be tested on its own.
 *
 * It doesn't compile anything; it reads declaration lines (Scriptname, Import, Function, Event,
 * Property, variables, State, Struct, CustomEvent) with comments removed, which is all that
 * looking up a name needs.
 */
import { LineState, TokenKind, isReservedWord, tokenizeLine } from './tokenizer';

export type SymbolKind = 'function' | 'event' | 'property' | 'variable' | 'parameter' | 'state' | 'struct' | 'customevent';

export interface ParameterInfo {
    type: string;
    name: string;
    /** Default value as written, e.g. "false" or "None". */
    defaultValue?: string;
    /** The parameter as written, e.g. "bool abSilent = false". */
    text: string;
}

export interface PapyrusSymbol {
    name: string;
    kind: SymbolKind;
    line: number;
    character: number;
    /** Declared type (variables, properties, parameters) or return type (functions). */
    type?: string;
    /** The declaration as written (comment removed, continuation lines joined). */
    signature: string;
    /** Text of a { doc comment } right after the declaration. */
    doc?: string;
    /** Functions/events: Native flag. */
    native?: boolean;
    /** Functions: Global flag. */
    global?: boolean;
    /** Functions/events: parameters in order. */
    params?: ParameterInfo[];
}

export interface FunctionScope {
    name: string;
    startLine: number;
    endLine: number;
    parameters: PapyrusSymbol[];
    locals: PapyrusSymbol[];
}

export interface ScriptInfo {
    name?: string;
    nameLine: number;
    nameCharacter: number;
    extends?: string;
    /** Doc comment after the Scriptname line. */
    doc?: string;
    imports: string[];
    /** Script-level symbols, by lower-case name (first declaration wins; states can redefine functions). */
    members: Map<string, PapyrusSymbol>;
    scopes: FunctionScope[];
}

const typePattern = '[A-Za-z_][\\w]*(?::[A-Za-z_]\\w*)*(?:\\[\\])?';
const scriptnameRe = /^\s*scriptname\s+([\w:]+)(?:\s+extends\s+([\w:]+))?/i;
const importRe = /^\s*import\s+([\w:]+)/i;
const functionRe = new RegExp(`^\\s*(?:(${typePattern})\\s+)?(function|event)\\s+(\\w+)\\s*\\(`, 'i');
const endFunctionRe = /^\s*end(function|event)\b/i;
const propertyRe = new RegExp(`^\\s*(${typePattern})\\s+property\\s+(\\w+)`, 'i');
const endPropertyRe = /^\s*endproperty\b/i;
const stateRe = /^\s*(?:auto\s+)?state\s+(\w+)/i;
const structRe = /^\s*struct\s+(\w+)/i;
const endStructRe = /^\s*endstruct\b/i;
const customEventRe = /^\s*customevent\s+(\w+)/i;
const variableRe = new RegExp(`^\\s*(${typePattern})\\s+([A-Za-z_]\\w*)\\b(?!\\s*[(.:])`, 'i');

/** Builtin types that can start a variable declaration. */
const declarableBuiltins = new Set(['bool', 'int', 'float', 'string', 'var']);

function isTypeWord(word: string) {
    const lower = word.replace(/\[\]$/, '').toLowerCase();
    return declarableBuiltins.has(lower) || !isReservedWord(lower);
}

/**
 * Splits a script into lines of code with comments blanked out (columns stay the same), and
 * collects doc comment text per line.
 */
function codeLines(text: string) {
    const raw = text.split(/\r?\n/);
    const code: string[] = [];
    const docs: (string | undefined)[] = [];
    const comments: (string | undefined)[] = [];
    let state: LineState = LineState.Normal;

    for (const line of raw) {
        const result = tokenizeLine(line, state);
        state = result.endState;
        let chars: string[] | undefined;
        let doc: string | undefined;
        let comment: string | undefined;
        for (const t of result.tokens) {
            if (t.kind === TokenKind.Comment || t.kind === TokenKind.DocComment) {
                chars ??= line.split('');
                for (let i = t.start; i < t.start + t.length; i++) {
                    chars[i] = ' ';
                }
                if (t.kind === TokenKind.DocComment) {
                    doc = (doc ? doc + '\n' : '') + line.substr(t.start, t.length);
                } else {
                    comment = (comment ? comment + ' ' : '') + line.substr(t.start, t.length);
                }
            }
        }
        code.push(chars ? chars.join('') : line);
        docs.push(doc);
        comments.push(comment);
    }

    return { code, docs, comments };
}

/** The doc comment starting on the line after `line` (blank lines skipped), braces removed. */
function docAfter(code: string[], docs: (string | undefined)[], line: number): string | undefined {
    let i = line + 1;
    while (i < code.length && code[i].trim() === '' && docs[i] === undefined) {
        i++;
    }
    if (i >= code.length || docs[i] === undefined || code[i].trim() !== '') {
        return undefined;
    }
    const parts: string[] = [];
    for (; i < code.length && docs[i] !== undefined; i++) {
        parts.push(docs[i]!);
        if (docs[i]!.includes('}')) {
            break;
        }
    }
    return parts
        .join('\n')
        .replace(/^\s*\{/, '')
        .replace(/\}\s*$/, '')
        .split('\n')
        .map((l) => l.trim())
        .join('\n')
        .trim();
}

/**
 * The ; comment lines directly above `line` (no blank line in between), with the ; removed.
 * Bethesda's scripts document functions this way.
 */
function commentAbove(code: string[], comments: (string | undefined)[], line: number): string | undefined {
    const parts: string[] = [];
    for (let i = line - 1; i >= 0; i--) {
        if (code[i].trim() !== '' || comments[i] === undefined) {
            break;
        }
        const text = comments[i]!
            .replace(/^;\/|\/;$/g, '')
            .replace(/^;+/, '')
            .trim();
        // Skip separator lines like ";=========="
        if (/^[=\-*_#~]+$/.test(text)) {
            break;
        }
        parts.unshift(text);
    }
    const doc = parts.join('\n').trim();
    return doc || undefined;
}

/** Splits on commas that aren't inside quotes or brackets. */
function splitTopLevel(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let inString = false;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (c === '\\') {
                i++;
            } else if (c === '"') {
                inString = false;
            }
        } else if (c === '"') {
            inString = true;
        } else if (c === '(' || c === '[') {
            depth++;
        } else if (c === ')' || c === ']') {
            depth--;
        } else if (c === ',' && depth === 0) {
            parts.push(text.substring(start, i));
            start = i + 1;
        }
    }
    parts.push(text.substring(start));
    return parts;
}

/** Joins a line with following "\"-continued lines. Returns the text and the last line used. */
function joinContinued(code: string[], line: number): { text: string; last: number } {
    let text = code[line].trimEnd();
    let last = line;
    while (text.endsWith('\\') && last + 1 < code.length) {
        last++;
        text = text.slice(0, -1).trimEnd() + ' ' + code[last].trim();
    }
    return { text: text.trim(), last };
}

/** The parameters of a function signature ("Function Foo(Int a, Bool b = false)"). */
export function parseParameterList(signature: string): ParameterInfo[] {
    const open = signature.indexOf('(');
    const close = signature.lastIndexOf(')');
    if (open < 0) {
        return [];
    }
    const inner = signature.substring(open + 1, close > open ? close : undefined);
    const params: ParameterInfo[] = [];
    for (const part of splitTopLevel(inner)) {
        const text = part.trim();
        const m = text.match(new RegExp(`^(${typePattern})\\s+(\\w+)(?:\\s*=\\s*(.+))?$`, 'i'));
        if (m) {
            params.push({ type: m[1], name: m[2], defaultValue: m[3]?.trim(), text });
        }
    }
    return params;
}

function parameterSymbols(params: ParameterInfo[], line: number, rawLine: string): PapyrusSymbol[] {
    return params.map((p) => ({
        name: p.name,
        kind: 'parameter' as const,
        line,
        character: Math.max(0, rawLine.search(new RegExp(`\\b${p.name}\\b`, 'i'))),
        type: p.type,
        signature: p.text,
    }));
}

function propertyNameColumn(lineText: string, name: string) {
    const keyword = lineText.search(/\bproperty\b/i);
    return keyword + lineText.substring(keyword).search(new RegExp(`\\b${name}\\b`, 'i'));
}

export function parseScript(text: string): ScriptInfo {
    const { code, docs, comments } = codeLines(text);
    const docFor = (line: number, lastLine = line) => docAfter(code, docs, lastLine) ?? commentAbove(code, comments, line);
    const info: ScriptInfo = { nameLine: 0, nameCharacter: 0, imports: [], members: new Map(), scopes: [] };

    let scope: FunctionScope | undefined;
    let inProperty = false; // full property with Get/Set functions
    let inStruct = false;

    const addMember = (sym: PapyrusSymbol) => {
        const key = sym.name.toLowerCase();
        if (!info.members.has(key)) {
            info.members.set(key, sym);
        }
    };

    for (let line = 0; line < code.length; line++) {
        const lineText = code[line];
        if (lineText.trim() === '') {
            continue;
        }

        let m: RegExpMatchArray | null;

        if (scope) {
            if (endFunctionRe.test(lineText)) {
                scope.endLine = line;
                scope = undefined;
                continue;
            }
            // Local variables
            m = lineText.match(variableRe);
            if (m && isTypeWord(m[1]) && !isReservedWord(m[2].toLowerCase())) {
                scope.locals.push({
                    name: m[2],
                    kind: 'variable',
                    line,
                    character: lineText.indexOf(m[2], lineText.indexOf(m[1]) + m[1].length),
                    type: m[1],
                    signature: lineText.trim(),
                });
            }
            continue;
        }

        if ((m = lineText.match(scriptnameRe))) {
            info.name = m[1];
            info.extends = m[2];
            info.nameLine = line;
            info.nameCharacter = lineText.indexOf(m[1]);
            info.doc = docFor(line);
            continue;
        }

        if ((m = lineText.match(importRe))) {
            info.imports.push(m[1]);
            continue;
        }

        if ((m = lineText.match(functionRe))) {
            const { text: signature, last } = joinContinued(code, line);
            const kind = m[2].toLowerCase() === 'event' ? 'event' : 'function';
            const flags = signature.substring(signature.lastIndexOf(')') + 1).toLowerCase();
            const native = /\bnative\b/.test(flags);
            const params = parseParameterList(signature);
            const sym: PapyrusSymbol = {
                name: m[3],
                kind,
                line,
                character: lineText.search(new RegExp(`\\b${m[3]}\\s*\\(`, 'i')),
                type: m[1],
                signature,
                doc: docFor(line, last),
                native,
                global: /\bglobal\b/.test(flags),
                params,
            };
            if (!inProperty) {
                addMember(sym);
            }
            if (!native) {
                scope = {
                    name: sym.name,
                    startLine: line,
                    endLine: code.length - 1,
                    parameters: parameterSymbols(params, line, lineText),
                    locals: [],
                };
                info.scopes.push(scope);
            }
            line = last;
            continue;
        }

        if (inProperty) {
            if (endPropertyRe.test(lineText)) {
                inProperty = false;
            }
            continue;
        }

        if (inStruct) {
            if (endStructRe.test(lineText)) {
                inStruct = false;
            }
            continue;
        }

        if ((m = lineText.match(propertyRe)) && isTypeWord(m[1])) {
            const sym: PapyrusSymbol = {
                name: m[2],
                kind: 'property',
                line,
                character: propertyNameColumn(lineText, m[2]),
                type: m[1],
                signature: lineText.trim(),
                doc: docFor(line),
            };
            addMember(sym);
            // A property without Auto / AutoReadOnly / Const has a Get/Set block until EndProperty.
            if (!/\b(auto|autoreadonly|const)\b/i.test(lineText.substring(lineText.search(/\bproperty\b/i)))) {
                inProperty = true;
            }
            continue;
        }

        if ((m = lineText.match(stateRe))) {
            addMember({
                name: m[1],
                kind: 'state',
                line,
                character: lineText.search(new RegExp(`\\b${m[1]}\\b`, 'i')),
                signature: lineText.trim(),
            });
            continue;
        }

        if ((m = lineText.match(structRe))) {
            addMember({
                name: m[1],
                kind: 'struct',
                line,
                character: lineText.search(new RegExp(`\\b${m[1]}\\b`, 'i')),
                signature: lineText.trim(),
                doc: docFor(line),
            });
            inStruct = true;
            continue;
        }

        if ((m = lineText.match(customEventRe))) {
            addMember({
                name: m[1],
                kind: 'customevent',
                line,
                character: lineText.search(new RegExp(`\\b${m[1]}\\b`, 'i')),
                signature: lineText.trim(),
            });
            continue;
        }

        m = lineText.match(variableRe);
        if (m && isTypeWord(m[1]) && !isReservedWord(m[2].toLowerCase())) {
            addMember({
                name: m[2],
                kind: 'variable',
                line,
                character: lineText.indexOf(m[2], lineText.indexOf(m[1]) + m[1].length),
                type: m[1],
                signature: lineText.trim(),
                doc: docFor(line),
            });
        }
    }

    return info;
}

/** The function/event scope containing `line`, if any. */
export function scopeAt(info: ScriptInfo, line: number): FunctionScope | undefined {
    return info.scopes.find((s) => s.startLine <= line && line <= s.endLine);
}
