import * as vscode from 'vscode';
import { LineCache } from './lineCache';
import { TokenKind } from './tokenizer';
import { ProjectIndex } from './projectIndex';

/**
 * Semantic token types, in TokenKind order, followed by the two identifier classifications.
 * Each is declared in package.json with a standard superType, so themes still color them
 * sensibly when Papyrus colors are turned off.
 */
export const tokenTypes = [
    'papyrusType', // 0  TokenKind.Type (+ script names)
    'papyrusFunctionKeyword', // 1
    'papyrusEventKeyword', // 2
    'papyrusPropertyKeyword', // 3
    'papyrusStructKeyword', // 4
    'papyrusStateKeyword', // 5
    'papyrusReturnKeyword', // 6
    'papyrusFlowKeyword', // 7
    'papyrusScriptnameKeyword', // 8
    'papyrusExtendsKeyword', // 9
    'papyrusKeyword', // 10
    'papyrusConstant', // 11
    'papyrusOperator', // 12
    'papyrusString', // 13
    'papyrusNumber', // 14
    'papyrusComment', // 15
    'papyrusDocComment', // 16
    'papyrusIdentifier', // 17 TokenKind.Identifier (properties / variables)
    'papyrusFunction', // 18 identifier followed by "("
];

const typeIndex = 0;
const identifierIndex = 17;
const functionIndex = 18;

export const legend = new vscode.SemanticTokensLegend(tokenTypes, []);

export class PapyrusSemanticTokens implements vscode.DocumentSemanticTokensProvider, vscode.Disposable {
    private readonly caches = new Map<string, LineCache>();
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    private readonly disposables: vscode.Disposable[] = [];

    readonly onDidChangeSemanticTokens = this.changeEmitter.event;

    constructor(private readonly index: ProjectIndex) {
        this.disposables.push(
            vscode.languages.registerDocumentSemanticTokensProvider({ language: 'papyrus' }, this, legend),

            // Only the edited lines are invalidated; they're re-tokenized on the next request.
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.languageId === 'papyrus' && e.contentChanges.length > 0) {
                    this.caches.get(e.document.uri.toString())?.applyChanges(e.contentChanges);
                }
            }),

            vscode.workspace.onDidCloseTextDocument((doc) => this.caches.delete(doc.uri.toString())),

            // The set of script names changed (a .ppj or .psc was added/removed): identifiers need
            // re-classifying. Tokens themselves are still valid, so nothing is re-tokenized.
            index.onDidChange(() => this.changeEmitter.fire())
        );
    }

    provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
        const key = document.uri.toString();
        let cache = this.caches.get(key);
        if (!cache) {
            cache = new LineCache();
            this.caches.set(key, cache);
        }

        const lines = cache.update(document);
        const scriptNames = this.index.scriptNames;
        const builder = new vscode.SemanticTokensBuilder(legend);

        for (let line = 0; line < lines.length; line++) {
            for (const token of lines[line].tokens) {
                let type: number = token.kind;
                if (token.kind === TokenKind.Identifier) {
                    if (token.call) {
                        type = functionIndex;
                    } else if (scriptNames.has(token.lower!)) {
                        type = typeIndex;
                    } else {
                        type = identifierIndex;
                    }
                }
                builder.push(line, token.start, token.length, type, 0);
            }
        }

        return builder.build();
    }

    dispose() {
        this.disposables.forEach((d) => d.dispose());
        this.changeEmitter.dispose();
    }
}
