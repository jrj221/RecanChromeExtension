// Closing the player tab takes you back to the Gradescope tab you opened it from.
//
// Chrome already does this when a tab is opened with an opener and you haven't switched tabs
// since; this makes it hold either way. It only acts when the player tab was the one in front
// when it closed, so closing it from the background never pulls you away from what you're doing.
//
// The background script is a service worker that can be stopped at any time, so what has to
// survive (which tab opened which, and which tab is in front) is kept in storage.session.

const opener = (tabId) => `opener:${tabId}`;
const front = (windowId) => `front:${windowId}`;

/** Start listening. Returns remember(viewerTabId, openerTabId), to call right after opening a player tab. */
export function trackTabReturns(api = chrome) {
  const session = api.storage.session;

  api.tabs.onActivated.addListener(({ tabId, windowId }) => {
    session.set({ [front(windowId)]: tabId }).catch(() => {});
  });

  api.tabs.onRemoved.addListener(async (tabId, { windowId, isWindowClosing }) => {
    try {
      const keys = [opener(tabId), front(windowId)];
      const stored = await session.get(keys);
      await session.remove(opener(tabId));
      const origin = stored[opener(tabId)];
      if (origin == null || isWindowClosing) return;
      if (stored[front(windowId)] !== tabId) return; // it wasn't the tab in front
      const tab = await api.tabs.get(origin); // throws if that tab is gone too
      await api.tabs.update(origin, { active: true });
      await api.windows.update(tab.windowId, { focused: true });
    } catch {
      // the original tab is gone; Chrome's own choice stands
    }
  });

  return (viewerTabId, openerTabId) => session.set({ [opener(viewerTabId)]: openerTabId });
}
