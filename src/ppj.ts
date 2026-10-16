import * as fs from 'fs';
import * as path from 'path';

/** Compiler settings from a .ppj. Anything not in the file is left out of the command line. */
export interface PpjCompileSettings {
    /** PapyrusCompiler.exe (the <Compiler> folder or exe, resolved). */
    compiler?: string;
    /** -flags= */
    flags?: string;
    /** -output= */
    output?: string;
    /** Game="sse" / "tesv" / "fo4" / "sf1", lower case, when set. */
    game?: string;
    optimize: boolean;
    debug: boolean;
    release: boolean;
    final: boolean;
    noRecurse: boolean;
    ignoreCwd: boolean;
    keepAsm: boolean;
    /** Folders the compiled .pex is copied to. */
    pexOutputFolders: string[];
    /** Folders the .psc is copied to. */
    pscOutputFolders: string[];
}

/** The parts of a .ppj project file this extension uses. */
export interface PpjProject {
    /** Absolute path of the .ppj file. */
    file: string;
    /** Source folders in priority order: <Imports> first (in order), then <Folders>. */
    folders: string[];
    compile: PpjCompileSettings;
}

function decodeXml(text: string) {
    return text
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

/** The inner text of each <tag>…</tag> (or "" for <tag/>) in `xml`. */
function elements(xml: string, tag: string): string[] {
    const re = new RegExp(`<${tag}(?:\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${tag}\\s*>)`, 'gi');
    return [...xml.matchAll(re)].map((m) => m[1] ?? '');
}

/** Attributes of the <PapyrusProject> element, lower-case names. */
function rootAttributes(xml: string): Map<string, string> {
    const result = new Map<string, string>();
    const root = xml.match(/<PapyrusProject\b([^>]*)>/i);
    if (root) {
        for (const m of root[1].matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
            result.set(m[1].toLowerCase(), decodeXml(m[2] ?? m[3] ?? ''));
        }
    }
    return result;
}

/** Strips quotes and expands %ENV% variables. */
function cleanValue(raw: string) {
    return decodeXml(raw)
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .replace(/%([^%]+)%/g, (all, name: string) => process.env[name] ?? all);
}

/**
 * Parses a .ppj. Source folders come from <Imports>/<Import> and <Folders>/<Folder>. Relative
 * paths are resolved against the .ppj's folder; Pyro remote entries (http/https URLs) are skipped.
 *
 * Compiler settings can be attributes of <PapyrusProject> (Pyro style, e.g. Optimize="true") or
 * elements (<Optimize>true</Optimize>, or just <Optimize/>).
 */
export function parsePpj(file: string, xml: string): PpjProject {
    const baseDir = path.dirname(file);
    const resolvePath = (value: string) => path.resolve(baseDir, value.replace(/[\\/]/g, path.sep));

    // Strip XML comments so commented-out entries are ignored.
    const text = xml.replace(/<!--[\s\S]*?-->/g, '');

    /**
     * Paths inside list blocks. Any child element counts (<Folder>, <Import>, ...), so a mixed-up
     * tag still works; a block with no child elements can hold "C:\\A;C:\\B" directly.
     */
    const folderList = (blocks: string[]) => {
        const result: string[] = [];
        const seen = new Set<string>();
        for (const block of blocks) {
            const items = [...block.matchAll(/<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([^<]*)<\/\1\s*>/gi)].map((m) => m[2]);
            const values = items.length > 0 ? items : block.includes('<') ? [] : [block];
            for (const item of values) {
                for (const part of item.split(';')) {
                    const value = cleanValue(part);
                    if (!value || /^https?:\/\//i.test(value)) {
                        continue;
                    }
                    const resolved = resolvePath(value);
                    const key = resolved.toLowerCase();
                    if (!seen.has(key)) {
                        seen.add(key);
                        result.push(resolved);
                    }
                }
            }
        }
        return result;
    };

    const imports = folderList(elements(text, 'Imports'));
    const sources = folderList(elements(text, 'Folders'));
    const folders = [...imports];
    for (const f of sources) {
        if (!folders.some((x) => x.toLowerCase() === f.toLowerCase())) {
            folders.push(f);
        }
    }

    const attributes = rootAttributes(text);
    const setting = (name: string): string | undefined => {
        const element = elements(text, name);
        if (element.length > 0) {
            return cleanValue(element[0]);
        }
        const attribute = attributes.get(name.toLowerCase());
        return attribute !== undefined ? cleanValue(attribute) : undefined;
    };
    const flag = (name: string) => {
        const value = setting(name);
        // <Optimize/> or <Optimize></Optimize> count as on.
        return value !== undefined && /^(true|1|yes|on|)$/i.test(value);
    };

    let compiler = setting('Compiler');
    if (compiler) {
        compiler = resolvePath(compiler);
        if (!/\.exe$/i.test(compiler)) {
            compiler = path.join(compiler, 'PapyrusCompiler.exe');
        }
    }

    // Pyro writes just the file name (Flags="TESV_Papyrus_Flags.flg"); the compiler then finds it
    // in the import folders. Use the path next to the .ppj only when it's there.
    let flags = setting('Flags');
    if (flags && !path.isAbsolute(flags)) {
        const local = resolvePath(flags);
        if (fs.existsSync(local)) {
            flags = local;
        }
    }

    const output = setting('Output');

    return {
        file,
        folders,
        compile: {
            compiler: compiler || undefined,
            flags: flags || undefined,
            output: output ? resolvePath(output) : undefined,
            game: setting('Game')?.toLowerCase() || undefined,
            optimize: flag('Optimize'),
            debug: flag('Debug'),
            release: flag('Release'),
            final: flag('Final'),
            noRecurse: flag('NoRecurse'),
            ignoreCwd: flag('IgnoreCwd'),
            keepAsm: flag('KeepAsm'),
            pexOutputFolders: folderList([...elements(text, 'PexOutputFolders'), ...elements(text, 'PexCopyFolders')]),
            pscOutputFolders: folderList([...elements(text, 'PscOutputFolders'), ...elements(text, 'PscCopyFolders')]),
        },
    };
}

export async function readPpj(file: string): Promise<PpjProject | undefined> {
    try {
        return parsePpj(file, await fs.promises.readFile(file, 'utf8'));
    } catch {
        return undefined;
    }
}

/**
 * Script names for a .psc file found under a source folder: the file name ("MyScript"), plus the
 * Fallout 4 namespaced name when it's in a subfolder ("MyMod:MyScript"). Original case.
 */
export function scriptNamesFor(folder: string, file: string): string[] {
    const base = path.basename(file, path.extname(file));
    const rel = path.relative(folder, file);
    const parts = rel.split(/[\\/]/);
    if (parts.length <= 1) {
        return [base];
    }
    parts[parts.length - 1] = base;
    return [base, parts.join(':')];
}

/** All .psc files under a folder (recursively), as absolute paths. Missing folders give []. */
export async function listScripts(folder: string): Promise<string[]> {
    try {
        const entries = await fs.promises.readdir(folder, { recursive: true });
        const result: string[] = [];
        for (const entry of entries) {
            const rel = String(entry);
            if (rel.toLowerCase().endsWith('.psc')) {
                result.push(path.join(folder, rel));
            }
        }
        return result;
    } catch {
        return [];
    }
}

/** .ppj files in `dir` and its parent folders (closest first), up to `maxLevels` levels. */
export async function findPpjUpwards(dir: string, maxLevels = 12): Promise<string[]> {
    const found: string[] = [];
    let current = dir;
    for (let level = 0; level < maxLevels; level++) {
        try {
            for (const name of await fs.promises.readdir(current)) {
                if (name.toLowerCase().endsWith('.ppj')) {
                    found.push(path.join(current, name));
                }
            }
        } catch {
            // unreadable folder: keep going up
        }
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    return found;
}
