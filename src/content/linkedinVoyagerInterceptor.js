(function () {
  if (window.__FOCALS_MAIN_VOYAGER_INTERCEPTOR__) return;
  window.__FOCALS_MAIN_VOYAGER_INTERCEPTOR__ = true;
  const log = (...args) => console.info("[FOCALS][MSG]", ...args);
  log("Intercepteur injecté dans le main world");

  const originalFetch = window.fetch;
  Object.defineProperty(window, "fetch", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: async function (...args) {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      try {
        const response = await originalFetch.apply(this, args);
        if (
          url?.includes("voyagerMessagingGraphQL") ||
          url?.includes("messaging/conversations") ||
          url?.includes("messengerMessages.5846eeb71c981f11e0134cb6626cc314") ||
          url?.includes("messengerMessagesBySyncToken")
        ) {
          const clone = response.clone();
          clone
            .json()
            .then((data) => {
              window.dispatchEvent(
                new CustomEvent("FOCALS_VOYAGER_DATA", {
                  detail: { url, data },
                })
              );
            })
            .catch(() => {});
        }
        return response;
      } catch (err) {
        throw err;
      }
    },
  });
})();
