// A page for trying what an add-on tab frame can and cannot do (F0-b).
// The test drives it through the DevTools protocol; these helpers are what
// it calls in the frame.
window.probe = {
  // Keeps the frame's main thread busy for `ms`.
  block(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* busy */
    }
    return true;
  },
  // fetch() from the page; resolves to 'ok <status>' or 'error <message>'.
  async fetchFrom(url) {
    try {
      const res = await fetch(url);
      return `ok ${res.status}`;
    } catch (err) {
      return `error ${err.message}`;
    }
  },
  // The same from a worker started from this add-on's folder.
  fetchFromWorker(url) {
    return new Promise((resolve) => {
      let worker;
      try {
        worker = new Worker('worker.js');
      } catch (err) {
        resolve(`no worker ${err.message}`);
        return;
      }
      worker.onmessage = (e) => {
        resolve(e.data);
        worker.terminate();
      };
      worker.onerror = (e) => resolve(`worker error ${e.message}`);
      worker.postMessage(url);
    });
  },
};
document.getElementById('status').textContent = `ready ${location.origin}`;
window.probeReady = true;
