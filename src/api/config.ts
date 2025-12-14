export const PROD_API_BASE_URL = 'https://ppawceknsedxaejpeylu.supabase.co/functions/v1';
export const DEV_API_BASE_URL = 'http://localhost:5000';

// Do not route extension builds to the local API, even when bundled in development
// mode. In the browser, `process.env.NODE_ENV` may stay set to "development", which
// caused requests to point to http://localhost:5000 and fail with CORS errors.
const isExtensionRuntime = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
const isExplicitDevFlag =
  typeof process !== 'undefined' && process.env?.FOCALS_USE_DEV_API === 'true';

// Avoid leaking the local API base URL in packaged extensions. An explicit env flag is
// required to opt into the dev endpoint, and it is ignored when the code is running
// inside an extension context.
export const IS_DEV = isExplicitDevFlag && !isExtensionRuntime;
export const API_BASE_URL = IS_DEV ? DEV_API_BASE_URL : PROD_API_BASE_URL;
