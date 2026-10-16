/**
 * Line-based Papyrus tokenizer. No VS Code dependencies, so it can be tested on its own.
 *
 * Papyrus is almost entirely one statement per line. The only things that span lines are
 * block comments (;/ ... /;) and doc comments ({ ... }), so each line is tokenized from a
 * small "start state" and reports the state it ends in. That is what makes it possible to
 * re-tokenize only the lines that changed.
 */

/** What a line starts or ends inside of. */
export const LineState = {
    Normal: 0,
    BlockComment: 1,
    DocComment: 2,
} as const;
export type LineState = (typeof LineState)[keyof typeof LineState];

/** Token kinds. Identifiers are classified later, because that depends on the project's script names. */
export const TokenKind = {
    // Resolved by the tokenizer
    Type: 0,
    FunctionKeyword: 1,
    EventKeyword: 2,
    PropertyKeyword: 3,
    StructKeyword: 4,
    StateKeyword: 5,
    ReturnKeyword: 6,
    FlowKeyword: 7,
    ScriptnameKeyword: 8,
    ExtendsKeyword: 9,
    Keyword: 10,
    Constant: 11,
    Operator: 12,
    String: 13,
    Number: 14,
    Comment: 15,
    DocComment: 16,
    // Classified at build time
    Identifier: 17,
} as const;
export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];

export interface Token {
    start: number;
    length: number;
    kind: TokenKind;
    /** Identifiers only: lower-case text, used for the script-name lookup. */
    lower?: string;
    /** Identifiers only: followed by "(" (so it's a function). */
    call?: boolean;
    /** Identifiers only: preceded by "." (a member, never a script type). */
    member?: boolean;
}

export interface LineResult {
    tokens: Token[];
    endState: LineState;
}

const builtinTypes = new Set(['bool', 'int', 'float', 'string', 'var', 'self', 'parent', 'none']);

const keywordKinds = new Map<string, TokenKind>([
    ['function', TokenKind.FunctionKeyword],
    ['endfunction', TokenKind.FunctionKeyword],
    ['event', TokenKind.EventKeyword],
    ['endevent', TokenKind.EventKeyword],
    ['customevent', TokenKind.EventKeyword],
    ['property', TokenKind.PropertyKeyword],
    ['endproperty', TokenKind.PropertyKeyword],
    ['auto', TokenKind.PropertyKeyword],
    ['autoreadonly', TokenKind.PropertyKeyword],
    ['mandatory', TokenKind.PropertyKeyword],
    ['struct', TokenKind.StructKeyword],
    ['endstruct', TokenKind.StructKeyword],
    ['state', TokenKind.StateKeyword],
    ['endstate', TokenKind.StateKeyword],
    ['return', TokenKind.ReturnKeyword],
    ['if', TokenKind.FlowKeyword],
    ['else', TokenKind.FlowKeyword],
    ['elseif', TokenKind.FlowKeyword],
    ['endif', TokenKind.FlowKeyword],
    ['while', TokenKind.FlowKeyword],
    ['endwhile', TokenKind.FlowKeyword],
    ['scriptname', TokenKind.ScriptnameKeyword],
    ['extends', TokenKind.ExtendsKeyword],
    ['import', TokenKind.Keyword],
    ['new', TokenKind.Keyword],
    ['as', TokenKind.Keyword],
    ['is', TokenKind.Keyword],
    ['native', TokenKind.Keyword],
    ['global', TokenKind.Keyword],
    ['const', TokenKind.Keyword],
    ['betaonly', TokenKind.Keyword],
    ['debugonly', TokenKind.Keyword],
    ['group', TokenKind.Keyword],
    ['endgroup', TokenKind.Keyword],
    ['collapsed', TokenKind.Keyword],
    ['collapsedonref', TokenKind.Keyword],
    ['collapsedonbase', TokenKind.Keyword],
    ['true', TokenKind.Constant],
    ['false', TokenKind.Constant],
    // Context dependent, see classifyWord: conditional / hidden are property flags on property
    // lines and script flags on Scriptname lines.
    ['conditional', TokenKind.PropertyKeyword],
    ['hidden', TokenKind.PropertyKeyword],
]);

/** All words the tokenizer treats as keywords (used by other modules to skip them). */
export function isReservedWord(lower: string): boolean {
    return keywordKinds.has(lower) || builtinTypes.has(lower);
}

function isIdentStart(c: number) {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; // A-Z a-z _
}

function isIdentPart(c: number) {
    return isIdentStart(c) || (c >= 48 && c <= 57); // + 0-9
}

function isDigit(c: number) {
    return c >= 48 && c <= 57;
}

const twoCharOperators = new Set(['==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%=']);
const oneCharOperators = new Set(['=', '<', '>', '+', '-', '*', '/', '%', '!']);

/**
 * Tokenizes one line, starting in `startState`.
 */
export function tokenizeLine(text: string, startState: LineState): LineResult {
    const tokens: Token[] = [];
    const n = text.length;
    let i = 0;
    let state: LineState = startState;
    // Where to start looking for the end of a comment opened on this line (skips the opener).
    let commentSearchFrom = 0;

    // Context for a few words whose category depends on the line.
    let firstWord: string | undefined;

    while (i < n) {
        // Inside a block comment: find "/;"
        if (state === LineState.BlockComment) {
            const end = text.indexOf('/;', Math.max(i, commentSearchFrom));
            const stop = end === -1 ? n : end + 2;
            if (stop > i) {
                tokens.push({ start: i, length: stop - i, kind: TokenKind.Comment });
            }
            i = stop;
            if (end !== -1) {
                state = LineState.Normal;
            }
            continue;
        }

        // Inside a doc comment: find "}"
        if (state === LineState.DocComment) {
            const end = text.indexOf('}', Math.max(i, commentSearchFrom));
            const stop = end === -1 ? n : end + 1;
            if (stop > i) {
                tokens.push({ start: i, length: stop - i, kind: TokenKind.DocComment });
            }
            i = stop;
            if (end !== -1) {
                state = LineState.Normal;
            }
            continue;
        }

        const c = text.charCodeAt(i);

        // Whitespace
        if (c === 32 || c === 9) {
            i++;
            continue;
        }

        // ;/ block comment, or ; line comment
        if (c === 59 /* ; */) {
            if (text.charCodeAt(i + 1) === 47 /* / */) {
                state = LineState.BlockComment;
                commentSearchFrom = i + 2;
                continue; // handled above, including the opening ";/"
            }
            tokens.push({ start: i, length: n - i, kind: TokenKind.Comment });
            break;
        }

        // { doc comment
        if (c === 123 /* { */) {
            state = LineState.DocComment;
            commentSearchFrom = i + 1;
            continue;
        }

        // "string"
        if (c === 34 /* " */) {
            let j = i + 1;
            while (j < n) {
                const d = text.charCodeAt(j);
                if (d === 92 /* \ */) {
                    j += 2;
                    continue;
                }
                j++;
                if (d === 34) {
                    break;
                }
            }
            j = Math.min(j, n);
            tokens.push({ start: i, length: j - i, kind: TokenKind.String });
            i = j;
            continue;
        }

        // Numbers: 0x1F, 12, 1.5, .5
        if (isDigit(c) || (c === 46 /* . */ && isDigit(text.charCodeAt(i + 1)))) {
            let j = i;
            if (c === 48 && (text.charCodeAt(i + 1) | 32) === 120 /* x */) {
                j += 2;
                while (j < n && /[0-9a-fA-F]/.test(text[j])) {
                    j++;
                }
            } else {
                while (j < n && isDigit(text.charCodeAt(j))) {
                    j++;
                }
                if (text.charCodeAt(j) === 46 && isDigit(text.charCodeAt(j + 1))) {
                    j++;
                    while (j < n && isDigit(text.charCodeAt(j))) {
                        j++;
                    }
                }
            }
            tokens.push({ start: i, length: j - i, kind: TokenKind.Number });
            i = j;
            continue;
        }

        // Identifiers and keywords (Fallout 4 names can be namespaced: MyMod:MyScript)
        if (isIdentStart(c)) {
            let j = i + 1;
            while (j < n) {
                const d = text.charCodeAt(j);
                if (isIdentPart(d)) {
                    j++;
                } else if (d === 58 /* : */ && isIdentStart(text.charCodeAt(j + 1))) {
                    j += 2;
                } else {
                    break;
                }
            }

            const word = text.substring(i, j);
            const lower = word.toLowerCase();

            // Look around for "(" after and "." before
            let k = j;
            while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) {
                k++;
            }
            const call = text.charCodeAt(k) === 40; /* ( */
            let b = i - 1;
            while (b >= 0 && (text.charCodeAt(b) === 32 || text.charCodeAt(b) === 9)) {
                b--;
            }
            const member = b >= 0 && text.charCodeAt(b) === 46; /* . */

            const kind = member ? undefined : classifyWord(lower, firstWord, text, j);

            if (kind !== undefined) {
                tokens.push({ start: i, length: j - i, kind });
            } else {
                tokens.push({ start: i, length: j - i, kind: TokenKind.Identifier, lower, call, member });
            }

            if (firstWord === undefined) {
                firstWord = lower;
            }
            i = j;
            continue;
        }

        // Operators
        const two = text.substring(i, i + 2);
        if (twoCharOperators.has(two)) {
            tokens.push({ start: i, length: 2, kind: TokenKind.Operator });
            i += 2;
            continue;
        }
        if (oneCharOperators.has(text[i])) {
            tokens.push({ start: i, length: 1, kind: TokenKind.Operator });
            i++;
            continue;
        }

        // Anything else: punctuation ( ) [ ] , . \ etc.
        i++;
    }

    return { tokens, endState: state };
}

/** Keyword/builtin category of a word, or undefined for a plain identifier. */
function classifyWord(
    lower: string,
    firstWord: string | undefined,
    text: string,
    wordEnd: number
): TokenKind | undefined {
    if (builtinTypes.has(lower)) {
        return TokenKind.Type;
    }

    const kind = keywordKinds.get(lower);
    if (kind === undefined) {
        return undefined;
    }

    // "Auto State Foo": Auto belongs to the state.
    if (lower === 'auto' && /^\s+state\b/i.test(text.substring(wordEnd))) {
        return TokenKind.StateKeyword;
    }

    // Script flags on the Scriptname line ("Scriptname Foo extends Bar Conditional Hidden").
    if ((lower === 'conditional' || lower === 'hidden') && firstWord === 'scriptname') {
        return TokenKind.Keyword;
    }

    // Keywords are reserved words in Papyrus, so everything else is a keyword everywhere.
    return kind;
}
