// A second add-on, to check that two add-ons' web storage stays apart.
document.getElementById('status').textContent = `ready ${location.origin}`;
window.probeReady = true;
