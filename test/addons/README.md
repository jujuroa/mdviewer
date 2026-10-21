# 시험용 add-on

시험용 add-on이다. 설치본에는 들어가지 않고, 소스에서 `--addon-dev`로 불러온다:
`npm start -- --addon-dev test/addons/test --addon-dev test/addons/other`. 앱 검사(`npm run test:app`)는 둘 다 불러와 띄운다.

| 폴더 | 쓰임 |
|---|---|
| `test/` | add-on 탭 프레임 시험(F0-b). `probe.js`의 `window.probe`를 시험 도구가 DevTools 프로토콜로 부른다. 허용 호스트는 `http://127.0.0.1:45678` |
| `other/` | 두 번째 add-on. 웹 저장소가 add-on마다 나뉘는지 확인 |

여는 방법: 메뉴 막대 "확장" > "Test: Probe" / "Other: Probe", 또는 탭 줄의 `+`. 시험 칸(`test/pane.html`)은 도움말 > 시험 칸 전환(`Ctrl+Alt+E`, 개발용).
