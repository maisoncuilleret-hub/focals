(function () {
  const { fetch: originalFetch } = window;
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const url = args[0]?.url || args[0] || "";

    if (url.includes("messengerMessages") || url.includes("messengerEvents")) {
      const clone = response.clone();
      clone
        .json()
        .then((data) => {
          window.postMessage({ type: "FOCALS_NETWORK_DATA", data }, "*");
        })
        .catch(() => {});
    }
    return response;
  };
})();
