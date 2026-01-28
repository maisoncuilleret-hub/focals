(function () {
  const { fetch: originalFetch } = window;
  if (typeof originalFetch !== "function") return;

  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const url = args[0]?.url || args[0] || "";

    // On cible le flux de messages (Historique + Nouveaux)
    if (url.includes("messengerMessages")) {
      const clone = response.clone();
      clone
        .json()
        .then((data) => {
          window.postMessage({ type: "VOYAGER_RAW_DATA", data }, "*");
        })
        .catch(() => {});
    }
    return response;
  };
})();
