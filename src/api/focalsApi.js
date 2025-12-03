import { API_BASE_URL } from './config.js';

const FOCALS_APP_BASE = 'https://mvp-recrutement.lovable.app';

async function callFocalsAPI(endpoint, payload) {
  const res = await fetch(`${API_BASE_URL}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let errorMessage = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) errorMessage = data.error;
    } catch (err) {
      // ignore JSON parse error
    }
    console.error(`[Focals API] ${endpoint} error:`, errorMessage);
    throw new Error(errorMessage);
  }

  return res.json();
}

async function bootstrapUser(userId) {
  return callFocalsAPI('focals-bootstrap-user', { userId });
}

async function getAllData(userId) {
  return callFocalsAPI('focals-get-data', { userId });
}

async function upsertSettings(userId, partial) {
  return callFocalsAPI('focals-upsert-settings', { userId, ...partial });
}

async function upsertJob(userId, jobInput) {
  return callFocalsAPI('focals-upsert-job', { userId, job: jobInput });
}

async function deleteJob(userId, jobId) {
  return callFocalsAPI('focals-delete-job', { userId, jobId });
}

async function upsertTemplate(userId, templateInput) {
  return callFocalsAPI('focals-upsert-template', { userId, template: templateInput });
}

async function deleteTemplate(userId, templateId) {
  return callFocalsAPI('focals-delete-template', { userId, templateId });
}

async function generateReply(request) {
  return callFocalsAPI('focals-generate-reply', request);
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
  upsertJob,
  deleteJob,
  upsertTemplate,
  deleteTemplate,
  generateReply,
  associateProfile,
};
