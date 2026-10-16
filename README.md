# Papyrus Language by Dylbill

Fast lightweight language support for papyrus (`.psc`) scripting, written in plain TypeScript with no language server.

# Features
## Syntax highlighting
- **Semantic syntax coloring**: types, script names, functions, properties/variables, and separate colors for Function, Event, Property, Struct, State, Return and flow keywords. Colors can be customized with the  **Papyrus: Customize Colors** command, or in settings. 
Search for **Dylbill Papyrus**. 

- **Performance**: 
When typing, only the lines you edit are re-colored, not the entire document which is better for performance.
Functions / properties are not verified in source files. 
Any word that has '(' after it is seen as a function. E.G CustomFunction(), MyVar.MyFunction() ect. 
Any word that doesn't match the other syntax highlighting rules gets the generic property color.
Again, this is for better performance. Script types, E.G ObjectReference, Actor, MyScript ect are verified.

## Intellisence
- **Peek Definition**
<img src="https://github.com/Dylbill-Iroh/papyrus-lang/raw/main/src/papyrus-lang-vscode/images/icon.png" width="100%" />

- **Go To Definition**

**hover Context**, with documentation, parameters and the full definition.

- **Autocomplete**: suggests global functions when typing **someScript.** or member functions when typing **someProperty**. `Event On…` inserts the full event with paramters and `EndEvent`.

- **Parameter hints** while typing function calls.

- **Project aware**: reads the source folders from your `.ppj` files (Imports first, then Folders).

## Compiling

**Commands**: 
Search for "papyrus" in the command pallete, open with (shift + ctrl + p).
Can also access in the editor and explorer right-click menus.

- **Papyrus - Compile Current Script**
- **Papyrus - Compile All Open Tabs**
- **Papyrus - Compile All Scripts in Current Folder** 

Everything about compiling comes from the script's `.ppj`. It's looked for in the script's folder and its parent folders first (closest first), then among the workspace's `.ppj` files. Settings can be attributes of `<PapyrusProject>` (Pyro style) or elements; anything left out is left off the command line.

- **Sounds**: You can set custom sounds for compile success and failure. In settings search for **Dylbill Papyrus: Compiler**.

## Requirements: .ppj files

This extension requires a .ppj file to work. Add the .ppj file to the location of your source .psc script or any of its parent folders.

**Example**:
SkyrimSE.ppj for Skyrim Special Edition located in C:\Mods\MyMod\

```xml
<?xml version='1.0'?>
<!-- Game: tesv, sse, fo4 or sf1 -->
<PapyrusProject xmlns="PapyrusProject.xsd"
    Game="sse"
    Optimize="false"
    Release="false"
    Final="false"
    Debug="false"
    IgnoreCwd="false"
    KeepAsm="false"
    NoRecurse="false">

    <!-- Folder containing PapyrusCompiler.exe, or the full path to the .exe -->
    <Compiler>C:\Program Files (x86)\Steam\steamapps\common\Skyrim Special Edition\Papyrus Compiler</Compiler>

    <!-- Flags file. A bare file name (TESV_Papyrus_Flags.flg) is found through the import folders. -->
    <Flags>C:\Program Files (x86)\Steam\steamapps\common\Skyrim Special Edition\Data\Scripts\Source\TESV_Papyrus_Flags.flg</Flags>

    <!-- Where the compiler writes the .pex (-output). If left out, the first PexOutputFolders entry is used. -->
    <Output>C:\Program Files (x86)\Steam\steamapps\common\Skyrim Special Edition\Data\Scripts</Output>

    <!-- Source folders, in priority order. Used for compile -import, coloring, hover and go to / peak definition. -->
    <Imports>
        <Import>C:\Mods\MyMod\Scripts\Source</Import>
        <Import>C:\Program Files (x86)\Steam\steamapps\common\Skyrim Special Edition\Data\Scripts\Source</Import>
    </Imports>
    <Folders>
        <Import>C:\Mods\MyMod\Scripts\Source</Import>
    </Folders>

    <!-- After a successful compile, the .pex is copied to each of these folders-->
    <PexOutputFolders>
        <Folder>C:\Program Files (x86)\Steam\steamapps\common\Skyrim Special Edition\Data\Scripts</Folder>
        <Import>C:\Mods\MyMod\Scripts</Import>
    </PexOutputFolders>

    <!-- After a successful compile, the .psc is copied to each of these folders-->
    <PscOutputFolders>
        <Folder>C:\Program Files (x86)\Steam\steamapps\common\Skyrim Special Edition\Data\Scripts\Source</Folder>
        <Import>C:\Mods\MyMod\Scripts\Source</Import>
    </PscOutputFolders>
</PapyrusProject>
```

## Credits
Claude for doing most of the heavy lifting.

# Support Me
- [Buy me a Coffee](https://ko-fi.com/dylbill)
- [Become a Patron](https://www.patreon.com/Dylbill)