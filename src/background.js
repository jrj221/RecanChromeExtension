// Opens the viewer tab for a recording. The viewer page does the fetch itself
// (extension pages with host_permissions are not subject to CORS), so the
// recording is only ever held in memory, never written to disk or storage.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "open-recording") return;
  const viewer = new URL(chrome.runtime.getURL("src/viewer.html"));
  viewer.searchParams.set("url", msg.url);
  viewer.searchParams.set("name", msg.name);
  chrome.tabs
    .create({ url: viewer.href })
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
