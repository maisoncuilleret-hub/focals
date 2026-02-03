import { API_BASE_URL, IS_DEV } from './config.js';
import { loadStoredToken } from './supabaseClient.js';
import { createLogger } from '../utils/logger.js';

const FOCALS_APP_BASE = 'https://mvp-recrutement.lovable.app';
const TALENTBASE_API_URL =
  'https://ppawceknsedxaejpeylu.supabase.co/functions/v1/save-engineer';
const logger = createLogger('FocalsApi');

const buildApiUrl = (endpoint = '') => {
  const normalizedBase = API_BASE_URL.replace(/\/?$/, '');
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${normalizedBase}${normalizedEndpoint}`;
};

async function postJson(endpoint, payload) {
  const url = buildApiUrl(endpoint);

  const token = await loadStoredToken();
  if (IS_DEV) {
    logger.debug('REQUEST', { url, hasPayload: Boolean(payload) });
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { apikey: token, Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload ?? {}),
  });

  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    const errorDetail = body?.error || body?.message || (typeof body === 'string' && body ? body : '');
    const message = errorDetail ? `HTTP ${res.status}: ${errorDetail}` : `HTTP ${res.status}`;
    if (IS_DEV) {
      logger.debug('ERROR', { url, status: res.status, message });
    }
    throw new Error(message);
  }

  if (IS_DEV) {
    logger.debug('RESPONSE', { url, status: res.status });
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

async function exportProfileToTalentBase(payload) {
  const body = {
    ...payload,
    exportedAt: payload?.exportedAt || new Date().toISOString(),
  };

  const res = await fetch(TALENTBASE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const contentType = res.headers.get('content-type') || '';
  const responseBody = contentType.includes('application/json')
    ? await res.json().catch(() => ({}))
    : await res.text();

  if (!res.ok) {
    const errorMessage =
      (responseBody && responseBody.error) ||
      (typeof responseBody === 'string' && responseBody) ||
      `HTTP ${res.status}`;
    throw new Error(errorMessage);
  }

  return responseBody;
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
  exportProfileToTalentBase,
};
