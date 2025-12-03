export const PROD_API_BASE_URL = 'https://ppawceknsedxaejpeylu.supabase.co/functions/v1';
export const DEV_API_BASE_URL = 'http://localhost:5000';
export const IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';
export const API_BASE_URL = IS_DEV ? DEV_API_BASE_URL : PROD_API_BASE_URL;
