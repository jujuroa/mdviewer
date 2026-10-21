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

알아 둘 것: 탭 iframe은 로드가 끝난 뒤에 건드린다. 로드 중에 `contentDocument`를 반복해서 읽으면 그 프레임의 preload가 붙지 않는다(`openWindowWith` 참고).
