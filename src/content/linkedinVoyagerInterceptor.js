(function () {
  if (window.__FOCALS_MAIN_VOYAGER_INTERCEPTOR__) return;
  window.__FOCALS_MAIN_VOYAGER_INTERCEPTOR__ = true;
  console.log("🔥 [SaaS-Debug] INTERCEPTEUR INJECTÉ DANS LE MAIN WORLD");

  const { fetch: originalFetch } = window;
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const url = args[0]?.url || args[0] || "";

    if (url.includes("voyager/api/messaging/conversations")) {
      const clone = response.clone();
      clone
        .json()
        .then((data) => {
          window.postMessage(
            { type: "FOCALS_VOYAGER_CONVERSATIONS", data },
            "*"
          );
        })
        .catch(() => {});
    }

    if (url.includes("messengerMessages") || url.includes("messengerEvents")) {
      const clone = response.clone();
      clone
        .json()
        .then((data) => {
          const text = data?.text || data?.body?.text;
          const conversationUrn = data?.conversationUrn || data?.conversation_urn;
          window.postMessage(
            { type: "FOCALS_NETWORK_DATA", data: { text, conversationUrn } },
            "*"
          );
        })
        .catch(() => {});
    }
    return response;
  };
})();
