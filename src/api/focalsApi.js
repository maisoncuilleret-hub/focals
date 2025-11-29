const FOCALS_API_BASE = 'https://ppawceknsedxaejpeylu.supabase.co/functions/v1';

async function callFocalsAPI(endpoint, payload) {
  const res = await fetch(`${FOCALS_API_BASE}/${endpoint}`, {
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

export {
  bootstrapUser,
  getAllData,
  upsertSettings,
  upsertJob,
  deleteJob,
  upsertTemplate,
  deleteTemplate,
  generateReply,
};
