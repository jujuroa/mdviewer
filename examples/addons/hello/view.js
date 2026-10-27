// The hello add-on's main view (every add-on has one: "Extensions > Hello >
// Open Window"). A tab cannot run a command itself, so it asks the
// background frame over messaging.
const api = window.mdviewerAddon;
const ko = api.app.locale === 'ko';
document.getElementById('hint').textContent = ko
  ? '버튼을 누르면 백그라운드 프레임이 인사하고 횟수를 셉니다. "확장 > Hello > 인사하기"도 같은 일을 합니다.'
  : 'The button asks the background frame to say hello and count. "Extensions > Hello > Say Hello" does the same.';
const button = document.getElementById('hello');
button.textContent = ko ? '인사하기' : 'Say Hello';
button.addEventListener('click', async () => {
  const count = await api.messaging.request({ to: 'background', message: { op: 'sayHello' } });
  document.getElementById('count').textContent = String(count);
});
api.ready();
