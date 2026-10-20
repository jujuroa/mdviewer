// Fetches the URL it is sent and reports back (see probe.fetchFromWorker).
self.onmessage = async (e) => {
  try {
    const res = await fetch(e.data);
    self.postMessage(`ok ${res.status}`);
  } catch (err) {
    self.postMessage(`error ${err.message}`);
  }
};
