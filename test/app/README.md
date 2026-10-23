# 앱 검사 (`npm run test:app`)

실제 앱을 임시 인스턴스로 띄워 DevTools 프로토콜로 조작하는 검사다. 단위 테스트(`npm test`)와 달리 창이 뜨며, 하나에 수십 초 걸린다.

- 인스턴스마다 임시 폴더(파일·`userData`)와 빈 디버깅 포트를 쓴다. 이미 실행 중인 MD Viewer나 사용자 설정에는 손대지 않고, 끝나면 자기가 띄운 프로세스만 종료하고 임시 폴더를 지운다.
- UI 언어는 한국어로 띄운다(상태 줄 문구를 비교하므로).
- `npm run test:app tabs disk`처럼 이름 앞부분을 주면 그 검사만 돈다.
- 시험 add-on(`test/addons/test`, `other`)을 `--addon-dev`로 불러오고, 설치 폴더는 임시 폴더(`MDVIEWER_ADDONS_DIR`)를 쓴다.
- main 프로세스 인스펙터에도 붙어 앱 메뉴 항목을 누를 수 있다(`app.clickMenu('확장', '확장 관리...')`, `app.main(코드)`). DevTools 키 입력(`Input.dispatchKeyEvent`, `nativeVirtualKeyCode` 포함)은 앱 메뉴 단축키까지 전달된다.

| 검사 | 내용 |
|---|---|
| `tabs` | 문서 탭 열기·탭 줄 표시·순서 바꾸기·초안·변경 표시·탭 창으로 옮기기·닫기(자동 저장) |
| `disk` | 편집 중 디스크 변경 (W4 Q7·Q8). 충돌 대화 상자의 세 선택지는 네이티브 대화 상자라 수동 점검 |
| `boundary` | 앱 IPC 경계와 프레임 이동 차단 (F0-a) |
| `addon-frame` | add-on 탭 프레임: 별도 프로세스, 응답성, 앱 다리 없음, CSP·이동·팝업·권한·저장소 (F0-b). 로컬 포트 45678·45679 사용 |
| `addon-bridge` | `mdviewerAddon` 다리, 호출자 판정·사칭 거부, 스냅샷 왕복, 모달 겹침 (F0-b) |
| `pane` | 문서 칸: 전환·원본 유지·폭 따로 기억·상하 배치·격리·프로세스·이동·언어 변경·멈춤 화면 (F0-c) |
| `addons` | add-on 찾기·관리 화면: 상태별 표시와 이유, 켜기·끄기, 다시 찾기, 정책 (F1) |
| `addon-tabs` | add-on 탭: 확장 메뉴로 열기, 단일·다중 인스턴스, 탭 줄 표시·`+`, add-on을 끄면 닫힘, 재실행 복원 (F2) |
| `background` | 백그라운드 프레임: 활성화 이벤트로 시작, 유휴 종료, 탭이 열린 동안 유지, 탭과 웹 저장소 공유, 비정상 종료 재시작·재시작 한도, add-on 끄면 중지, 마지막 창을 닫으면 앱 종료 (F2) |
| `consent` | 첫 실행 전 동의: 시작 시 활성화·탭 열기 때 묻기, 거부·허용·기록, 다시 열 때 안 묻기, 업데이트로 늘면 다시 묻기, `--addon-dev`는 안 묻기 (F2) |
| `addon-log` | 확장 로그: add-on 프레임 콘솔(수준 유지)·실패한 호출, 화면 실시간 갱신, add-on별 보기, `logs/<id>.log` 파일 (F2) |
| `commands` | 명령 팔레트(`Ctrl+Shift+P`·메뉴, 걸러내기, 키보드), 백그라운드 명령(onCommand로 시작)·탭 명령(탭을 열어 전달), ctx.source, 로그 (F3) |
| `menus` | 메뉴 기여(확장 메뉴, 탐색기·탭·편집창 우클릭)와 `when`, 단축키(숨긴 메뉴 항목), 앱 단축키와 충돌 시 앱 우선·관리 화면 표시 (F3). 우클릭 메뉴는 main에서 `Menu.prototype.popup`을 가로채 확인 |
| `settings` | add-on 설정(관리 화면 설정 모달·`settings/get`·`update`·형식 검사), 비밀 값(`safeStorage`, 평문 저장 안 함), `context/set`으로 `when`이 바뀌는 메뉴 (F3) |

알아 둘 것:
- 탭 iframe은 로드가 끝난 뒤에 건드린다. 로드 중에 `contentDocument`를 반복해서 읽으면 그 프레임의 preload가 붙지 않는다(`openWindowWith` 참고).
- 앱 출력은 임시 폴더의 `app.log`로 받는다(파이프로 받으면 main보다 오래 사는 보조 프로세스 때문에 Node가 멈출 수 있음). 정리할 때는 하네스가 연 DevTools 연결을 모두 닫고, 앱을 끝내고, 그 임시 폴더 경로를 명령줄에 가진 남은 보조 프로세스만 종료한다.
- 앱을 스스로 끝내게 하는 검사는 다른 연결을 닫은 뒤(`app.closeSessions(w)`) 페이지에서 `Page.close`로 끝낸다. main 인스펙터나 add-on iframe 연결이 열린 채 앱이 끝나면 Node가 멈추는 경우가 있었다.
