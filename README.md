# MD Viewer

웹 엔진(Electron/Chromium) 기반 마크다운 뷰어 & 에디터입니다. 프로젝트 폴더를 트리로 탐색하고, 문서를 렌더링해서 보고, 커스텀 CSS로 스타일을 꾸미고, 필요하면 본문을 바로 편집·저장할 수 있습니다.

## 주요 기능

- **프로젝트 트리뷰**: 루트 폴더를 지정하면 좌측에 폴더/파일 트리가 표시되고, `.md` 파일을 클릭해 미리보기
- **마크다운 렌더링**: `markdown-it` + `highlight.js` 기반, GFM 스타일 표·체크박스·코드 하이라이팅 지원. 기본 스타일은 VS Code 에디터(Dark+/Light+) 톤에 맞춰져 있음
- **커스텀 CSS 편집**
  - 우측 패널에서 CSS를 입력하면 미리보기에 즉시 반영
  - 프로젝트별로 `.mdviewer/custom.css`에 저장
  - 다른 프로젝트의 스타일을 가져와 기본값으로 사용 가능 ("가져오기")
  - 켜기/끄기 토글로 커스텀 스타일 적용 여부를 바로 비교 가능
- **본문(소스) 편집**: "편집" 모드에서 원본 마크다운을 좌우 분할 화면으로 편집하며 실시간 미리보기, `Ctrl+S`로 저장
- **문서 검색**: `Ctrl+F`로 열려 있는 문서 안에서 찾기, `Ctrl+Shift+F`로 프로젝트 전체 문서 본문 검색 (대/소문자 구분·단어 단위·정규식 옵션, 결과 클릭 시 해당 위치로 이동)
- **뷰어 확대/축소**: 미리보기 영역에서 `Ctrl`+휠로 문서 배율 조절(50~300%), `Ctrl+0`으로 복귀. 배율은 프로젝트별로 저장됨
- **현재 문서 전체화면으로 보기**: `F11`(또는 툴바 ⛶)로 창을 전체화면으로 바꾸고 탐색기·툴바·편집기 등 주변 UI를 숨겨 본문만 보여 줌(목차는 유지). `Esc`나 `F11`로 종료
- **드래그 앤 드롭**: 파일/폴더를 탐색기(트리)에 놓으면 그 폴더로 복사되고, 뷰어에 놓으면 프로젝트를 건드리지 않고 그 문서를 바로 보여 줌(임시 보기)
- **최근 프로젝트**: 프로젝트가 열려 있지 않을 때 시작 화면과 File 메뉴에 최근 연 폴더(최대 5~8개) 표시, 클릭 시 바로 열기
- **파일 자동 감시**: 외부 편집기 등에서 파일이 바뀌면 자동으로 새로고침 (편집 모드 중에는 일시 중단)
- **링크/이미지 처리**: 문서 간 상대 링크는 앱 내에서 이동, 상대 경로 이미지는 자동 해석, 외부 링크(http/https)는 기본 브라우저로 오픈

## 기술 스택

- [Electron](https://www.electronjs.org/) — 데스크톱 앱 셸 (Chromium 렌더링 엔진)
- [markdown-it](https://github.com/markdown-it/markdown-it) + `markdown-it-task-lists` — 마크다운 파싱
- [highlight.js](https://highlightjs.org/) (`vs2015` 테마) — 코드 하이라이팅
- [sanitize-html](https://github.com/apostrophecms/sanitize-html) — 렌더링된 HTML 새니타이징

## 실행 방법

```bash
npm install
npm start
```

> `npm start`는 `scripts/start.js`를 통해 실행됩니다. VS Code 통합 터미널 등 일부 환경에서 `ELECTRON_RUN_AS_NODE` 환경 변수가 남아있어 Electron이 일반 Node 프로세스로 실행되는 문제가 있어, 이를 자동으로 제거한 뒤 앱을 띄우도록 처리되어 있습니다.

## 설치 파일(Windows 인스톨러) 만들기

[electron-builder](https://www.electron.build/)로 NSIS 설치 파일을 생성합니다. 설치하면 데스크톱/시작메뉴 바로가기가 만들어지고, `.md`/`.markdown` 파일이 MD Viewer로 열 수 있는 프로그램 목록에 등록됩니다(기본 프로그램으로 지정하려면 설치 후 Windows 설정 → 앱 → 기본 앱에서 사용자가 직접 선택해야 합니다).

```bash
npm install        # 최초 1회
npm run dist        # dist/MD Viewer Setup <version>.exe 생성
```

- 압축 해제된 실행 폴더만 빠르게 확인하려면: `npm run pack` → `dist/win-unpacked/MD Viewer.exe`
- 버전을 올리려면 `package.json`의 `"version"` 값을 수정합니다. 앱 내 **Help(도움말) → About MD Viewer(MD Viewer 정보)** 메뉴와 설치된 exe의 속성(우클릭 → 속성 → 자세히)에 이 값이 그대로 반영됩니다.
- 빌드 관련 설정은 `package.json`의 `"build"` 필드(아이콘, 파일 연결, NSIS 옵션)와 `build/icon.ico`에 있습니다.
- 빌드 중 `EPERM ... rename win-unpacked.tmp` 오류가 뜨면, 방금 압축 해제된 `electron.exe`를 백신(Windows Defender 등)이 스캔하며 잠깐 잠그기 때문인 경우가 많습니다. `dist/win-unpacked`(및 `.tmp`) 폴더를 지우고 `npm run dist`를 다시 실행하면 보통 해결됩니다.

## 프로젝트 구조

```text
mdviewer/
├─ main.js              # Electron 메인 프로세스 (창 생성, 메뉴, IPC 핸들러, 마크다운 렌더링)
├─ preload.js           # 렌더러에 안전한 IPC API 노출 (contextBridge)
├─ assets/
│  ├─ preview-base.css      # 미리보기 기본 스타일 (VS Code 톤)
│  ├─ default-user-css.css  # 새 프로젝트의 커스텀 CSS 시작 템플릿
│  └─ icon.png / icon.ico   # 앱/창 아이콘
├─ build/icon.ico       # 설치 파일(exe) 아이콘 (electron-builder buildResources)
├─ src/
│  ├─ index.html        # 앱 레이아웃 (트리뷰 / 미리보기 / CSS 편집기)
│  ├─ renderer.js       # 렌더러 로직 (트리, 미리보기, CSS/본문 편집, 최근 프로젝트 등)
│  └─ ui.css            # 앱 UI(크롬) 스타일
├─ scripts/start.js     # ELECTRON_RUN_AS_NODE 우회 실행 스크립트
└─ sample-project/      # 기능 확인용 샘플 마크다운 프로젝트
```

## 단축키

| 단축키 | 동작 |
| --- | --- |
| `Ctrl+O` | 폴더 열기 |
| `Ctrl+Shift+O` | 단일 파일 열기 |
| `Ctrl+E` | CSS 편집기 열기/닫기 |
| `Ctrl+Shift+E` | 본문 편집 모드 전환 |
| `Ctrl+S` | (편집 모드 중) 저장 |
| `F11` | 현재 문서 전체화면으로 보기 / 종료 (`Esc`로도 종료) |

## 커스텀 CSS 저장 위치

프로젝트 폴더 기준 `.mdviewer/custom.css`에 저장됩니다. 이 폴더/파일은 버전 관리에 포함할지 여부를 프로젝트 상황에 맞게 선택하면 됩니다.
