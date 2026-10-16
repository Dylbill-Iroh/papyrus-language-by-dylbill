import { type LineResult, LineState, tokenizeLine } from './tokenizer';

/** Minimal view of a text document, so the cache can be tested without VS Code. */
export interface LineSource {
    readonly lineCount: number;
    lineAt(line: number): { readonly text: string };
}

/** Minimal view of a document change (same shape as vscode.TextDocumentContentChangeEvent). */
export interface LineChange {
    readonly range: { readonly start: { readonly line: number }; readonly end: { readonly line: number } };
    readonly text: string;
}

interface CachedLine extends LineResult {
    startState: LineState;
}

/**
 * Tokens for one document, cached per line.
 *
 * Edits only invalidate the lines they touch; `update` then re-tokenizes just those lines. A
 * line after an edit is also re-tokenized when its start state changed (e.g. you typed ";/" and
 * opened a block comment), and that keeps rippling down only while the state keeps changing.
 */
export class LineCache {
    private lines: (CachedLine | undefined)[] = [];
    private initialized = false;

    /** Lines re-tokenized by the last update (for diagnostics / tests). */
    lastRetokenizedCount = 0;

    /** Applies a document's content changes, invalidating only the affected lines. */
    applyChanges(changes: readonly LineChange[]) {
        if (!this.initialized) {
            return;
        }

        // Changes are applied in order; each one's range refers to the document as left by the
        // previous change in the list (VS Code delivers multi-cursor edits in that form).
        for (const change of changes) {
            const startLine = change.range.start.line;
            const endLine = change.range.end.line;
            let insertedLines = 1;
            for (let i = 0; i < change.text.length; i++) {
                if (change.text.charCodeAt(i) === 10 /* \n */) {
                    insertedLines++;
                }
            }

            const removed = endLine - startLine + 1;
            const placeholders: undefined[] = new Array(insertedLines).fill(undefined);
            this.lines.splice(startLine, removed, ...placeholders);
        }
    }

    /** Clears everything, forcing a full re-tokenize on the next update. */
    reset() {
        this.lines = [];
        this.initialized = false;
    }

    /**
     * Brings the cache up to date with the document and returns the cached lines.
     * Only invalid lines (and lines whose start state changed) are tokenized.
     */
    update(doc: LineSource): readonly LineResult[] {
        if (!this.initialized || this.lines.length !== doc.lineCount) {
            // First time, or we got out of sync somehow: tokenize everything.
            this.lines = new Array(doc.lineCount).fill(undefined);
            this.initialized = true;
        }

        let state: LineState = LineState.Normal;
        let count = 0;

        for (let line = 0; line < doc.lineCount; line++) {
            let cached = this.lines[line];
            if (!cached || cached.startState !== state) {
                const result = tokenizeLine(doc.lineAt(line).text, state);
                cached = { ...result, startState: state };
                this.lines[line] = cached;
                count++;
            }
            state = cached.endState;
        }

        this.lastRetokenizedCount = count;
        return this.lines as CachedLine[];
    }

    /** The cached tokens of one line (after `update`), if any. */
    getLine(line: number): LineResult | undefined {
        return this.lines[line];
    }
}
