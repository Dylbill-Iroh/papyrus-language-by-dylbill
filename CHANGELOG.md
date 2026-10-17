# Change Log
 
All notable changes to the "papyrus-language-by-dylbill" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.2] - 2026-10-16
- Initial release

## [0.0.3] - 2026-10-17
### Fixed
- Made it so when typing a closing block word (Endif, EndFunction, EndState ect...) it snaps to the appropriate tab, where as before it only snapped if you typed out the whole word. 

### Added
- Added a rename feature. (F2 or right click → Rename Symbol): renames a variable, property or function everywhere it's used in your source folders. Each match is checked to really refer to the same declaration, so same-named variables in other functions or scripts, comments and strings are left alone. Overrides in child scripts are renamed with their parent; native functions and events the game calls by name (like OnActivate) can't be renamed.
