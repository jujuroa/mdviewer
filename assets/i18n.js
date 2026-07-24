// Shared UI string table. Main process uses this directly (via require);
// the renderer receives the active language's strings over IPC (see
// 'i18n:get' in main.js) since sandboxed preload scripts cannot require
// local modules.

const STRINGS = {
  en: {
    'menu.file': 'File',
    'menu.openFolder': 'Open Folder...',
    'menu.openFile': 'Open File...',
    'menu.save': 'Save',
    'menu.recentProjects': 'Recent Projects',
    'menu.noRecentProjects': 'No recent projects',
    'menu.view': 'View',
    'menu.toggleCssEditor': 'Toggle CSS Editor',
    'menu.toggleEditMode': 'Toggle Edit Mode',
    'menu.toggleTerminal': 'Toggle Terminal',
    'menu.reload': 'Reload',
    'menu.toggleDevTools': 'Toggle Developer Tools',
    'menu.settings': 'Settings',
    'menu.language': 'Language',
    'menu.languageEnglish': 'English',
    'menu.languageKorean': '한국어',

    'context.openInExplorer': 'Show in Explorer',

    'term.noRunningTerminal': 'No terminal is running',

    'sidebar.openFolderBtn': 'Open Folder',
    'sidebar.openFolderTitle': 'Open project folder (Ctrl+O)',
    'sidebar.openFileBtn': 'Open File',
    'sidebar.openFileTitle': 'Open a single file (Ctrl+Shift+O)',
    'sidebar.noFolderOpen': 'No folder is open',
    'sidebar.openProjectFolderBtn': 'Open Project Folder',
    'sidebar.openProjectFolderTitle': 'Open project folder in Explorer',

    'toolbar.selectDocument': 'Select a document',
    'toolbar.saveTitle': 'Save (Ctrl+S)',
    'toolbar.saveBtn': 'Save',
    'toolbar.editBtn': 'Edit',
    'toolbar.editTitle': 'Toggle body edit mode (Ctrl+Shift+E)',
    'toolbar.cssAppliedTitle': 'Custom CSS applied',
    'toolbar.cssDisabledTitle': 'Custom CSS not applied (default style)',
    'toolbar.cssAppliedBadge': 'Custom CSS',
    'toolbar.cssEditBtn': 'CSS Edit',
    'toolbar.cssEditTitle': 'Open/close CSS editor (Ctrl+E)',
    'toolbar.terminalBtn': 'Terminal',
    'toolbar.terminalTitle': 'Open/close terminal (Ctrl+`)',

    'editor.placeholder': 'Enter markdown source',

    'welcome.hint': 'No project is open. Open a folder or select a recent project.',
    'welcome.openFolderBtn': 'Open Folder',
    'welcome.openFileBtn': 'Open File',
    'welcome.recentProjects': 'Recent Projects',

    'toc.dragTitle': 'Drag to move / click to collapse-expand',
    'toc.heading': 'Table of Contents',
    'toc.subpages': 'Sub-pages',
    'toc.noHeadings': 'This document has no headings',
    'toc.selectDocument': 'Select a document',
    'toc.noSubfolder': '"{name}" folder does not exist',

    'css.title': 'Custom CSS',
    'css.toggleTitle': 'Apply/disable custom CSS in preview',
    'css.importBtn': 'Import',
    'css.importTitle': "Import another project's style as default",
    'css.importFromRecent': 'Import from recent projects',
    'css.browseFolder': 'Choose Folder...',
    'css.saveBtn': 'Save',
    'css.resetBtn': 'Reset',
    'css.placeholder': '/* Enter CSS to preview it live */',
    'css.restoredLastSaved': 'Reverted to last saved state',
    'css.unsavedChanges': 'You have unsaved changes',
    'css.appliedOn': 'Custom CSS applied',
    'css.appliedOff': 'Custom CSS disabled (showing default style)',
    'css.openFolderFirst': 'Open a folder first to save',
    'css.savedTo': 'Saved (.mdviewer/custom.css)',
    'css.saveFailed': 'Save failed: {error}',
    'css.importFailed': 'Import failed: {error}',
    'css.noOtherProjects': 'No other projects to import from',
    'css.importedPending': 'Imported (not saved yet): {path}',

    'terminal.title': 'Terminal',
    'terminal.clearBtn': 'Clear',
    'terminal.clearTitle': 'Clear output',
    'terminal.restartBtn': 'Restart',
    'terminal.restartTitle': 'Restart shell',
    'terminal.closeTitle': 'Close terminal',
    'terminal.shellExited': 'Shell exited (code {code})',

    'preview.emptyState': 'Open a folder and select a markdown file',
    'folder.openFailed': 'Cannot open folder: {error}',
    'recent.none': 'No recently opened projects',
    'recent.notFoundSuffix': ' (not found)',
    'recent.notFoundPathSuffix': ' — not found',
    'recent.removeTitle': 'Remove from list',
    'tree.readError': '(cannot read: {error})',
    'file.openFailed': 'Cannot open file: {error}',
    'confirm.discardChanges': 'You have unsaved changes. Leave without saving?',
    'edit.selectFirst': 'Select a document first',
    'edit.readFailed': 'Failed to read: {error}',
    'edit.saved': 'Saved',
    'edit.saveFailed': 'Save failed: {error}',
    'edit.unsavedChanges': 'You have unsaved changes',
  },
  ko: {
    'menu.file': '파일',
    'menu.openFolder': '폴더 열기...',
    'menu.openFile': '파일 열기...',
    'menu.save': '저장',
    'menu.recentProjects': '최근 프로젝트',
    'menu.noRecentProjects': '최근 프로젝트 없음',
    'menu.view': '보기',
    'menu.toggleCssEditor': 'CSS 편집기 전환',
    'menu.toggleEditMode': '편집 모드 전환',
    'menu.toggleTerminal': '터미널 전환',
    'menu.reload': '새로고침',
    'menu.toggleDevTools': '개발자 도구 전환',
    'menu.settings': '설정',
    'menu.language': '언어',
    'menu.languageEnglish': 'English',
    'menu.languageKorean': '한국어',

    'context.openInExplorer': '탐색기에서 상위 폴더 열기',

    'term.noRunningTerminal': '실행 중인 터미널이 없습니다',

    'sidebar.openFolderBtn': '폴더 열기',
    'sidebar.openFolderTitle': '프로젝트 폴더 열기 (Ctrl+O)',
    'sidebar.openFileBtn': '파일 열기',
    'sidebar.openFileTitle': '단일 파일 열기 (Ctrl+Shift+O)',
    'sidebar.noFolderOpen': '폴더가 열려 있지 않습니다',
    'sidebar.openProjectFolderBtn': '프로젝트 폴더 열기',
    'sidebar.openProjectFolderTitle': '탐색기에서 프로젝트 폴더 열기',

    'toolbar.selectDocument': '문서를 선택하세요',
    'toolbar.saveTitle': '저장 (Ctrl+S)',
    'toolbar.saveBtn': '저장',
    'toolbar.editBtn': '편집',
    'toolbar.editTitle': '본문 편집 모드 전환 (Ctrl+Shift+E)',
    'toolbar.cssAppliedTitle': '커스텀 CSS 적용됨',
    'toolbar.cssDisabledTitle': '커스텀 CSS 적용 안 함 (기본 스타일)',
    'toolbar.cssAppliedBadge': '커스텀 CSS',
    'toolbar.cssEditBtn': 'CSS 편집',
    'toolbar.cssEditTitle': 'CSS 편집기 열기/닫기 (Ctrl+E)',
    'toolbar.terminalBtn': '터미널',
    'toolbar.terminalTitle': '터미널 열기/닫기 (Ctrl+`)',

    'editor.placeholder': '마크다운 소스를 입력하세요',

    'welcome.hint': '열려 있는 프로젝트가 없습니다. 폴더를 열거나 최근 프로젝트를 선택하세요.',
    'welcome.openFolderBtn': '폴더 열기',
    'welcome.openFileBtn': '파일 열기',
    'welcome.recentProjects': '최근 프로젝트',

    'toc.dragTitle': '드래그로 이동 / 클릭으로 접기·펼치기',
    'toc.heading': '목차',
    'toc.subpages': '하위 페이지',
    'toc.noHeadings': '이 문서에는 제목이 없습니다',
    'toc.selectDocument': '문서를 선택하세요',
    'toc.noSubfolder': '"{name}" 폴더가 없습니다',

    'css.title': '커스텀 CSS',
    'css.toggleTitle': '미리보기에 커스텀 CSS 적용/해제',
    'css.importBtn': '가져오기',
    'css.importTitle': '다른 프로젝트의 스타일을 기본값으로 가져오기',
    'css.importFromRecent': '최근 프로젝트에서 가져오기',
    'css.browseFolder': '폴더 선택...',
    'css.saveBtn': '저장',
    'css.resetBtn': '되돌리기',
    'css.placeholder': '/* CSS를 입력하면 미리보기에 바로 반영됩니다 */',
    'css.restoredLastSaved': '마지막 저장 상태로 되돌렸습니다',
    'css.unsavedChanges': '저장되지 않은 변경 사항이 있습니다',
    'css.appliedOn': '커스텀 CSS를 적용했습니다',
    'css.appliedOff': '커스텀 CSS를 껐습니다 (기본 스타일 표시 중)',
    'css.openFolderFirst': '먼저 폴더를 열어야 저장할 수 있습니다',
    'css.savedTo': '저장됨 (.mdviewer/custom.css)',
    'css.saveFailed': '저장 실패: {error}',
    'css.importFailed': '가져오기 실패: {error}',
    'css.noOtherProjects': '가져올 다른 프로젝트가 없습니다',
    'css.importedPending': '가져옴 (저장 전): {path}',

    'terminal.title': '터미널',
    'terminal.clearBtn': '지우기',
    'terminal.clearTitle': '출력 지우기',
    'terminal.restartBtn': '재시작',
    'terminal.restartTitle': '셸 다시 시작',
    'terminal.closeTitle': '터미널 닫기',
    'terminal.shellExited': '셸이 종료되었습니다 (code {code})',

    'preview.emptyState': '폴더를 열고 마크다운 파일을 선택하세요',
    'folder.openFailed': '폴더를 열 수 없습니다: {error}',
    'recent.none': '최근에 연 프로젝트가 없습니다',
    'recent.notFoundSuffix': ' (찾을 수 없음)',
    'recent.notFoundPathSuffix': ' — 찾을 수 없음',
    'recent.removeTitle': '목록에서 제거',
    'tree.readError': '(읽을 수 없음: {error})',
    'file.openFailed': '파일을 열 수 없습니다: {error}',
    'confirm.discardChanges': '저장하지 않은 변경 사항이 있습니다. 저장하지 않고 이동하시겠습니까?',
    'edit.selectFirst': '먼저 문서를 선택하세요',
    'edit.readFailed': '읽기 실패: {error}',
    'edit.saved': '저장됨',
    'edit.saveFailed': '저장 실패: {error}',
    'edit.unsavedChanges': '저장되지 않은 변경 사항이 있습니다',
  },
};

const DEFAULT_LANGUAGE = 'ko';
const SUPPORTED_LANGUAGES = ['en', 'ko'];

function translate(language, key, vars) {
  const table = STRINGS[language] || STRINGS[DEFAULT_LANGUAGE];
  let str = table[key] !== undefined ? table[key] : STRINGS[DEFAULT_LANGUAGE][key] || key;
  if (vars) {
    for (const name of Object.keys(vars)) {
      str = str.split('{' + name + '}').join(vars[name]);
    }
  }
  return str;
}

module.exports = { STRINGS, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, translate };
