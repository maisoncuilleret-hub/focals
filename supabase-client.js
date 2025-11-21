import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://ppawceknsedxaejpeylu.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwYXdjZWtuc2VkeGFlanBleWx1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg4MTUzMTUsImV4cCI6MjA3NDM5MTMxNX0.G3XH8afOmaYh2PGttY3CVRwi0JIzIvsTKIeeynpKpKI";

const chromeStorageAdapter = {
  async getItem(key) {
    const result = await chrome.storage.local.get(key);
    const value = result?.[key];
    return typeof value === "string" ? value : null;
  },
  async setItem(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async removeItem(key) {
    await chrome.storage.local.remove(key);
  },
};

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: chromeStorageAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

export default supabase;
