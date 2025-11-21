import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://ppawceknsedxaejpeylu.supabase.co";
const SUPABASE_ANON_KEY = "REPLACE_WITH_ANON_KEY";

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
