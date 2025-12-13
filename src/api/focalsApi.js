import { API_BASE_URL, IS_DEV } from './config.js';
import { SUPABASE_ANON_KEY } from '../../supabase-client.js';

const FOCALS_APP_BASE = 'https://mvp-recrutement.lovable.app';

const buildApiUrl = (endpoint = '') => {
  const normalizedBase = API_BASE_URL.replace(/\/?$/, '');
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${normalizedBase}${normalizedEndpoint}`;
};

async function postJson(endpoint, payload) {
  const url = buildApiUrl(endpoint);

  if (IS_DEV) {
    console.log('[FOCALS][API][REQUEST]', { url, payload });
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(payload ?? {}),
  });

  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    const errorDetail = body?.error || body?.message || (typeof body === 'string' && body ? body : '');
    const message = errorDetail ? `HTTP ${res.status}: ${errorDetail}` : `HTTP ${res.status}`;
    if (IS_DEV) {
      console.error('[FOCALS][API][ERROR]', { url, status: res.status, message, payload });
    }
    throw new Error(message);
  }

  if (IS_DEV) {
    console.log('[FOCALS][API][RESPONSE]', { url, status: res.status });
  }

  return body;
}

async function bootstrapUser(userId) {
  return postJson('focals-bootstrap-user', { userId });
}

async function getAllData(userId) {
  return postJson('focals-get-data', { userId });
}

async function upsertSettings(userId, partial) {
  const payload = { userId };
  if (partial && Object.prototype.hasOwnProperty.call(partial, 'default_tone')) {
    payload.default_tone = partial.default_tone;
  }
  if (partial && Object.prototype.hasOwnProperty.call(partial, 'system_prompt_override')) {
    payload.system_prompt_override = partial.system_prompt_override;
  }
  return postJson('focals-upsert-settings', payload);
}

async function upsertTemplate(userId, templateInput) {
  return postJson('focals-upsert-template', { userId, template: templateInput });
}

async function deleteTemplate(userId, templateId) {
  return postJson('focals-delete-template', { userId, templateId });
}

async function generateReply(request) {
  return postJson('focals-generate-reply', request);
}

async function generateFollowup(request) {
  return postJson('focals-generate-reply', request);
}

async function associateProfile(profile, accessToken, userId) {
  const res = await fetch(`${FOCALS_APP_BASE}/api/associate-profile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ profile, userId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }

  return res.json();
}

export {
  bootstrapUser,
  getAllData,
  upsertSettings,
  upsertTemplate,
  deleteTemplate,
  generateReply,
  generateFollowup,
  associateProfile,
};
