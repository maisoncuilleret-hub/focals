# How to debug (Focals extension)

## Activer les logs DEBUG

1. Ouvrir la console de la page LinkedIn.
2. Dans la console, exécuter :
   ```js
   chrome.storage.local.set({ focals_log_level: "debug" })
   ```
3. Recharger la page LinkedIn pour voir les logs `[FOCALS][SCOPE]`.

> Pour revenir au niveau par défaut :
> ```js
> chrome.storage.local.remove("focals_log_level")
> ```

## Tester le scraper DOM profil

1. Vérifier que le flag est actif (ON par défaut) :
   ```js
   chrome.storage.local.set({ focals_dom_profile_scraper_enabled: true })
   ```
2. Ouvrir un profil LinkedIn (`/in/...`).
3. Vérifier dans la console :
   - `[FOCALS][SCRAPER] Profile DOM scrape start`
   - `[FOCALS][SCRAPER] Profile DOM scrape complete` (status `complete`/`partial`)
4. Naviguer vers un autre profil (navigation SPA) et vérifier que le scrape se relance.

## Tester la messagerie (API)

1. Ouvrir la messagerie LinkedIn.
2. Vérifier que les logs indiquent :
   - `[FOCALS][NET] messaging api scraping enabled`
   - `[FOCALS][MSG]` pour les flux interceptés.

## Vérifier l’absence de scraping API profil

1. S’assurer que le flag est désactivé :
   ```js
   chrome.storage.local.set({ focals_profile_api_scraper_enabled: false })
   ```
2. Vérifier au démarrage :
   - `[FOCALS][NET] profile api scraping disabled`
3. Lors d’un scrape profil DOM, aucun log de type “profile network hit” ne doit apparaître.
