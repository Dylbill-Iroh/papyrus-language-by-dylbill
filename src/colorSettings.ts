/**
 * The color settings: setting key (under dylbillPapyrus.colors), the semantic token type it
 * colors, a label, a description and a sample for the color picker. Default colors are in
 * package.json, which is the single source for them.
 */
export interface ColorSetting {
    key: string;
    tokenType: string;
    title: string;
    description: string;
    sample: string;
    group: 'Names' | 'Keywords' | 'Literals and comments';
}

export const configSection = 'dylbillPapyrus';
export const colorsSection = `${configSection}.colors`;

export const colorSettings: ColorSetting[] = [
    {
        key: 'function',
        tokenType: 'papyrusFunction',
        title: 'Function',
        description: 'Any name followed by "(", e.g. MyCustomFunction in MyScript.MyCustomFunction().',
        sample: 'MyCustomFunction()',
        group: 'Names',
    },
    {
        key: 'type',
        tokenType: 'papyrusType',
        title: 'Type',
        description:
            'Bool, Int, Float, String, Var, Self, Parent, None, and script names: any .psc in a .ppj source folder whose name is longer than 3 characters.',
        sample: 'Actor Int Self None',
        group: 'Names',
    },
    {
        key: 'identifier',
        tokenType: 'papyrusIdentifier',
        title: 'Property / Variable',
        description: 'Every other name: properties, variables and parameters.',
        sample: 'MyActor myActorName',
        group: 'Names',
    },
    {
        key: 'functionKeyword',
        tokenType: 'papyrusFunctionKeyword',
        title: 'Function Keyword',
        description: 'Function and EndFunction.',
        sample: 'Function EndFunction',
        group: 'Keywords',
    },
    {
        key: 'eventKeyword',
        tokenType: 'papyrusEventKeyword',
        title: 'Event Keyword',
        description: 'Event, EndEvent and CustomEvent.',
        sample: 'Event EndEvent',
        group: 'Keywords',
    },
    {
        key: 'propertyKeyword',
        tokenType: 'papyrusPropertyKeyword',
        title: 'Property Keyword',
        description: 'Property, EndProperty and property flags (Auto, AutoReadOnly, Conditional, Hidden, Mandatory).',
        sample: 'Property Auto EndProperty',
        group: 'Keywords',
    },
    {
        key: 'structKeyword',
        tokenType: 'papyrusStructKeyword',
        title: 'Struct Keyword',
        description: 'Struct and EndStruct (Fallout 4).',
        sample: 'Struct EndStruct',
        group: 'Keywords',
    },
    {
        key: 'stateKeyword',
        tokenType: 'papyrusStateKeyword',
        title: 'State Keyword',
        description: 'State, EndState, and Auto before State.',
        sample: 'Auto State EndState',
        group: 'Keywords',
    },
    {
        key: 'returnKeyword',
        tokenType: 'papyrusReturnKeyword',
        title: 'Return Keyword',
        description: 'Return.',
        sample: 'Return',
        group: 'Keywords',
    },
    {
        key: 'flowKeyword',
        tokenType: 'papyrusFlowKeyword',
        title: 'Flow Keyword',
        description: 'If, ElseIf, Else, EndIf, While and EndWhile.',
        sample: 'If ElseIf Else EndIf While',
        group: 'Keywords',
    },
    {
        key: 'scriptnameKeyword',
        tokenType: 'papyrusScriptnameKeyword',
        title: 'Scriptname Keyword',
        description: 'Scriptname.',
        sample: 'Scriptname',
        group: 'Keywords',
    },
    {
        key: 'extendsKeyword',
        tokenType: 'papyrusExtendsKeyword',
        title: 'Extends Keyword',
        description: 'Extends.',
        sample: 'Extends',
        group: 'Keywords',
    },
    {
        key: 'keyword',
        tokenType: 'papyrusKeyword',
        title: 'Other Keywords',
        description: 'Import, New, As, Is, Native, Global, Const, BetaOnly, DebugOnly, Group/EndGroup, script flags.',
        sample: 'Import Native Global As',
        group: 'Keywords',
    },
    {
        key: 'constant',
        tokenType: 'papyrusConstant',
        title: 'True / False',
        description: 'True and False.',
        sample: 'True False',
        group: 'Literals and comments',
    },
    {
        key: 'operator',
        tokenType: 'papyrusOperator',
        title: 'Operator',
        description: 'Operators such as = + == != && ||.',
        sample: '= + == && !=',
        group: 'Literals and comments',
    },
    {
        key: 'string',
        tokenType: 'papyrusString',
        title: 'String',
        description: 'String literals.',
        sample: '"Hello"',
        group: 'Literals and comments',
    },
    {
        key: 'number',
        tokenType: 'papyrusNumber',
        title: 'Number',
        description: 'Number literals.',
        sample: '42 3.14 0xFF',
        group: 'Literals and comments',
    },
    {
        key: 'comment',
        tokenType: 'papyrusComment',
        title: 'Comment',
        description: '; line comments and ;/ block comments /;.',
        sample: '; a comment',
        group: 'Literals and comments',
    },
    {
        key: 'docComment',
        tokenType: 'papyrusDocComment',
        title: 'Documentation Comment',
        description: '{ documentation comments }.',
        sample: '{ Documentation }',
        group: 'Literals and comments',
    },
];
