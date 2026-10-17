import { LineState, TokenKind, tokenizeLine } from './tokenizer';

/** A line that opens a block (same rules as language-configuration.json, minus Else/ElseIf). */
const openerRe =
    /^\s*(?:(?:[\w:]+(?:\[\])?\s+)?(?:function|event)\b(?!.*\bnative\b)|if\b|while\b|(?:auto\s+)?state\b|struct\b|group\b|(?:[\w:]+(?:\[\])?\s+)?property\b(?!.*\b(?:auto|autoreadonly|const)\b))/i;

/** A line that closes a block. */
const closerRe = /^\s*end(?:function|event|if|while|state|struct|group|property)\b/i;

/** Keywords that line up with the block they belong to (EndIf with its If, and so on). */
export const outdentKeywords = new Set([
    'endfunction', 'endevent', 'endif', 'endwhile', 'endstate', 'endstruct', 'endgroup', 'endproperty',
    'else', 'elseif',
]);

/**
 * The indentation of the innermost block still open at `line`: the If an EndIf/Else belongs to,
 * the Function an EndFunction closes, and so on. Comments and strings are ignored.
 */
export function blockIndent(getLine: (line: number) => string, line: number): string | undefined {
    let state: LineState = LineState.Normal;
    const stack: string[] = [];
    for (let i = 0; i < line; i++) {
        const raw = getLine(i);
        const result = tokenizeLine(raw, state);
        state = result.endState;

        let code = raw;
        for (const t of result.tokens) {
            if (t.kind === TokenKind.Comment || t.kind === TokenKind.DocComment || t.kind === TokenKind.String) {
                code = code.substring(0, t.start) + ' '.repeat(t.length) + code.substring(t.start + t.length);
            }
        }

        if (closerRe.test(code)) {
            stack.pop();
        } else if (openerRe.test(code)) {
            stack.push(/^\s*/.exec(raw)![0]);
        }
    }
    return stack.length > 0 ? stack[stack.length - 1] : undefined;
}
