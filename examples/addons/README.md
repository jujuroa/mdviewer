# MD Viewer add-on 개발 안내

MD Viewer 2.0부터 add-on으로 앱에 명령·메뉴·탭·설정을 더할 수 있다. 이 문서는 add-on을 처음 만드는 사람을 위한 안내이고, 이 폴더의 예제 세 개가 그대로 출발점이 된다. 규약 전체는 `.lab/addon/03-protocol.md`에 있다.

| 예제 | 보여 주는 것 |
|---|---|
| `hello/` | 가장 작은 add-on. 대표 view 하나와, 백그라운드 프레임이 명령 하나를 처리하고, 설정을 읽고, 데이터 폴더에 횟수를 적고, 알림을 띄운다. 이름·제목은 `locales/`로 현지화 |
| `hello-tab/` | 자기 탭을 가진 add-on. 탭 줄의 제목과 변경 표시를 바꾸고, 창을 옮기거나 앱을 다시 켜도 값을 잃지 않는다 |
| `ai-edit/` | AI 편집 add-on의 흐름을 규칙으로 흉내 낸다. 선택(없으면 문서 전체)을 읽고, 규칙을 고르게 하고, 진행 표시를 띄운 뒤, 비교 화면을 거쳐 문서를 고친다 |

## 1. 시작하기

소스에서 앱을 실행하면서 add-on 폴더를 넘긴다. 설치본은 이 인자를 무시한다.

```powershell
npm start -- --addon-dev=examples/addons/hello
```

설치본에서도 쓰려면 "확장 > 확장 관리..."의 [add-on 등록...]에서 add-on 폴더의 `manifest.json`을 고른다. 등록한 폴더는 앱을 다시 켜도 기억되고, 실험 API와 자동 다시 불러오기는 `--addon-dev`와 같다. 처음 켤 때 권한 동의를 묻는 것만 다르다. [등록 해제]로 뺀다.

여러 개는 인자를 반복한다. `--addon-dev`로 불러온 add-on은 다음과 같이 다뤄진다.

- 처음 실행할 때의 동의를 묻지 않는다.
- 폴더 안의 파일이 바뀌면 자동으로 다시 불러온다(0.3초 동안 모아서 한 번). 명령 "개발: add-on 다시 불러오기"(확장 메뉴, `Ctrl+Shift+P`)로도 된다.
- manifest에 적은 실험 API를 쓸 수 있다.

"확장 > 확장 관리..."에서 상태(정상·호환되지 않음·꺼짐)와 manifest 오류를 필드 경로와 함께 볼 수 있다.

## 2. 폴더와 manifest

```text
hello/
├── manifest.json       필수. 폴더 이름 = id
├── view.html, view.js  대표 view (필수 — 확장 메뉴 "창 열기")
├── background.html     백그라운드 프레임 (선택)
├── background.js
└── locales/            "%키%" 문자열 (선택)
    ├── en.json
    └── ko.json
```

`hello/manifest.json`이 최소 형태다.

```json
{
  "manifestVersion": 1,
  "id": "hello",
  "name": "%name%",
  "version": "1.0.0",
  "engines": { "mdviewer": ">=2.0.0 <3.0.0", "api": 1 },
  "background": { "entry": "background.html", "idleTimeoutSec": 30 },
  "contributes": {
    "tabs": [{ "id": "hello.view", "title": "%tab.view%", "entry": "view.html" }],
    "commands": [{ "id": "hello.sayHello", "title": "%command.sayHello%" }],
    "menus": { "menubar/addons": [{ "command": "hello.sayHello" }] }
  }
}
```

- `id`는 소문자로 시작하는 2~40자(`a-z`, `0-9`, `-`)이고 폴더 이름과 같아야 한다. 명령·탭 id는 `<id>.`로 시작한다.
- **탭(대표 view)이 하나 이상 있어야 한다.** 확장 메뉴에는 add-on마다 하위 메뉴가 생기고 첫 항목 "창 열기"가 대표 view(`"main": true`인 탭, 없으면 첫 탭)를 연다. 그 아래 `menubar/addons` 항목이 온다.
- `engines.capabilities`(예: `{ "edit": 1 }`)를 적으면 그 영역 버전이 없는 앱에서는 "호환되지 않음"이 된다.
- 문서를 읽으려면 `permissions`에 `documents.read`, 고치려면 `documents.write`를 적는다. 권한 없는 호출은 `PermissionDenied`.
- 기여 지점은 `commands`, `menus`(`menubar/addons`, `editor/context`, `explorer/item`, `tab/context`, `viewer/selection`), `keybindings`, `tabs`, `settings`, `secrets`다. 메뉴 항목의 `when`으로 보일 때를 정한다(`editMode`, `activeDocument`, `resourceExt == 'md'`, `hasSelection` 등).

## 3. 프레임

add-on은 앱이 만든 sandbox 프레임 안에서 돈다. 다른 origin(`mdviewer-addon://<id>/`)이라 앱 화면이나 Node에 손댈 수 없고, 앱 기능은 전역 `mdviewerAddon`으로만 쓴다.

| 프레임 | 언제 뜨나 | 쓰임 |
|---|---|---|
| 백그라운드 | 활성화 이벤트(명령 실행, 탭 열기, `onStartup`, `onProjectContains:<파일>`) 또는 `messaging.request` | 명령 처리, 오래 사는 상태. 화면이 없다. `idleTimeoutSec` 동안 할 일이 없으면 멈춘다 |
| 탭 | 사용자가 확장 메뉴·탭 줄 `+`·팔레트로 열 때, `tabs.open` | 화면. **창을 옮기거나 창이 다시 불러와지면 새로 로드된다** |

탭이 다시 로드돼도 화면 상태를 잃지 않으려면 `hello-tab/tab.js`처럼 한다.

```js
api.lifecycle.onSnapshot(() => ({ count }));          // 옮기기 직전에 넘길 것
const { reason, state } = api.tabs.getRestoreState(); // 'new' | 'moved' | 'reloaded' | 'restored'
if (state) count = state.count;
api.tabs.setState({ state: { count } });              // 앱을 다시 켠 뒤에도 (64 KiB까지)
api.ready();
```

모든 프레임은 준비가 끝나면 `ready()`를 부른다. 10초 안에 부르지 않으면 로그에 남는다. 명령은 `commands.register(id, handler)`로 받는다. 처리기가 돌려준 값이 명령의 결과가 된다.

## 4. API 한눈에

메서드는 모두 Promise를 돌려주고, 실패하면 `{ code, name, message, data? }` 오류로 거부된다(`name`: `NotFound`, `Conflict`, `UserCanceled`, `OutsideProject`, `PermissionDenied`, `TooLarge`, `NotSupported` …).

| 영역 | 메서드 | 비고 |
|---|---|---|
| `app` | `locale`·`theme`·`capabilities` 등 값, `openExternal`, `copyToClipboard` | |
| `workspace` | `projects`, `listFiles`, `openDocument` | `listFiles`는 `documents.read` |
| `documents` | `read`, `active` | 열린 문서는 저장 안 한 내용 포함. `version`은 내용 SHA-1 |
| `editor` | `selection` | 위치는 `{ line, character }`, 둘 다 0부터 |
| `edit` | `apply` | 비교 화면에서 사용자가 확인. 전부 아니면 전무. 읽은 뒤 바뀌었으면 `Conflict` |
| `ui` | `notify`, `quickPick`, `input`, `confirm`, `progress.start/report/end` | 부른 프레임의 창에 뜬다 |
| `tabs` | `open`, `close`, `reveal`, `update`, `setState/getState`, `getRestoreState`, `getArgs` | 자기 add-on의 탭만 |
| `settings`·`secrets`·`context` | `get/update`, `get/set/delete`, `set` | 비밀 값은 OS 암호화(safeStorage) |
| `storage` | `readFile`, `writeFile`, `list`, `delete`, `paths` | 데이터 폴더 안 상대 경로만. `global`/`project` 범위 |
| `messaging` | `post`, `request`, `onMessage` | 같은 add-on의 프레임끼리 |

### 문서 고치기

`ai-edit/background.js`가 보여 주는 순서다. 읽을 때 받은 `version`을 `baseVersion`으로 넘겨야 그사이 바뀐 문서를 덮어쓰지 않는다.

```js
const sel = await api.editor.selection();
const result = await api.edit.apply({
  label: '마크다운 다듬기',
  operations: [{ kind: 'change', path: sel.path, baseVersion: sel.version, changes: [{ range: sel.range, newText }] }],
});
// { applied: true } 또는 사용자가 취소하면 { applied: false, reason: 'rejected' }
```

편집 중인 문서에 적용된 변경은 편집기에서 `Ctrl+Z`로 되돌릴 수 있다. `kind`는 `change`·`create`·`rename`·`delete`이고, 이름 바꾸기와 삭제는 항상 확인을 받는다.

## 5. 타입 정의

`addons/types/index.d.ts`에 `mdviewerAddon`의 타입이 있다. 편집기 자동 완성을 쓰려면 add-on 폴더에 `jsconfig.json`을 두고 그 파일을 포함하거나, 스크립트 첫 줄에 참조를 적는다.

```js
/// <reference path="../../../addons/types/index.d.ts" />
```

## 6. 개발 도구

| 도구 | 쓰는 법 |
|---|---|
| 개발자 도구 | 소스 실행 때 add-on 탭 우클릭 "개발자 도구"(그 프레임으로 열림), 관리 화면의 백그라운드 "개발자 도구" |
| 확장 로그 | "확장 > 확장 로그" 또는 관리 화면의 "로그". 프레임 시작·멈춤, 거부된 호출, 실패한 API. 파일은 `%LOCALAPPDATA%\mdviewer\logs\addons\<id>.log` |
| API 추적 | "확장 > API 추적": 호출(메서드·소요 시간·결과) 또는 호출과 인자. 비밀 값과 문서 텍스트는 길이만 남는다 |
| 다시 불러오기 | 파일 저장 시 자동, 또는 "개발: add-on 다시 불러오기". 탭은 스냅샷을 넘기고(`reason: 'reloaded'`), 돌던 백그라운드는 다시 시작된다 |

## 7. 제약

- 네트워크는 manifest `network.hosts`에 적은 주소로만 나갈 수 있다(CSP). 그 밖의 `fetch`, 다른 주소로의 이동, `window.open`, 폼 전송은 막힌다.
- 파일은 `storage/*`의 데이터 폴더(`%LOCALAPPDATA%\mdviewer\addon-data\<id>\`)와, 권한이 있으면 열린 프로젝트 안의 문서만 다룬다.
- 실험 API(`experimentalApi`, 예: `documents.sync`, `settings.changed`, `settings.open`)는 `--addon-dev`로 불러왔거나 설정 `addons.allowExperimentalApi`에 있는 add-on에만 열리고, 2.x 어느 버전에서든 바뀔 수 있다. 앱에 없는 이름은 관리 화면에 경고로 나온다.
- 새 영역 버전이 필요한 메서드는 쓰기 전에 `mdviewerAddon.app.capabilities`로 확인한다.
