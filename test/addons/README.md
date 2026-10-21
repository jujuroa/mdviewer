# 시험용 add-on

시험용 add-on이다. 설치본에는 들어가지 않고, 소스에서 `--addon-dev`로 불러온다:
`npm start -- --addon-dev test/addons/test --addon-dev test/addons/other`. 앱 검사(`npm run test:app`)는 둘 다 불러와 띄운다.

| 폴더 | 쓰임 |
|---|---|
| `test/` | add-on 탭 프레임 시험(F0-b). `probe.js`의 `window.probe`를 시험 도구가 DevTools 프로토콜로 부른다. 허용 호스트는 `http://127.0.0.1:45678` |
| `other/` | 두 번째 add-on. 웹 저장소가 add-on마다 나뉘는지 확인 |

여는 방법: 도움말 > 시험 탭 열기…(개발용)에서 파일을 고르거나, 창 페이지에서
`window.mdviewer.openTestTab('mdviewer-addon://test/probe.html')`.
