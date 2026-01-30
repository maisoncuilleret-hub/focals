(function () {
  const originalFetch = window.fetch;
  // On utilise defineProperty pour contourner le verrouillage SES de LinkedIn
  Object.defineProperty(window, "fetch", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: async function (...args) {
      const url = typeof args[0] === "string" ? args[0] : args[0].url || "";

      // On exécute d'abord la requête pour ne pas bloquer le site
      try {
        const response = await originalFetch.apply(this, args);
        // On filtre uniquement les flux de messagerie
        if (
          url.includes("voyagerMessagingGraphQL") ||
          url.includes("messaging/conversations")
        ) {
          const clone = response.clone();
          clone
            .json()
            .then((data) => {
              // Envoi sécurisé vers le content-script principal
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
