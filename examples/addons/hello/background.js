// The hello add-on's background frame. It starts when its command runs
// (onCommand:hello.sayHello, inferred from contributes.commands) and stops
// after idleTimeoutSec with nothing to do.
const api = window.mdviewerAddon;

// How many times it said hello, kept in the add-on's data folder.
async function countHello() {
  let count = 0;
  try {
    count = Number(await api.storage.readFile({ scope: 'global', path: 'count.txt' })) || 0;
  } catch (err) {
    if (err.name !== 'NotFound') throw err;
  }
  count += 1;
  await api.storage.writeFile({ scope: 'global', path: 'count.txt', data: String(count) });
  return count;
}

api.commands.register('hello.sayHello', async () => {
  const greeting = await api.settings.get({ key: 'greeting' });
  const count = await countHello();
  const message = api.app.locale === 'ko' ? `${greeting}! (${count}번째)` : `${greeting}! (#${count})`;
  await api.ui.notify({ message });
  return count;
});

// Set up: the app may send commands now.
api.ready();
