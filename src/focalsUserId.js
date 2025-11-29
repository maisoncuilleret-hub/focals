const STORAGE_KEY = 'focals_user_id';

async function getOrCreateUserId() {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        const existing = result?.[STORAGE_KEY];
        if (existing && typeof existing === 'string') {
          resolve(existing);
          return;
        }
        const newId = crypto.randomUUID();
        chrome.storage.local.set({ [STORAGE_KEY]: newId }, () => resolve(newId));
      });
    } catch (err) {
      reject(err);
    }
  });
}

let cachedUserId = null;
async function getUserIdCached() {
  if (cachedUserId) return cachedUserId;
  cachedUserId = await getOrCreateUserId();
  return cachedUserId;
}

export { getOrCreateUserId, getUserIdCached };
