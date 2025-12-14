import { API_BASE_URL, IS_DEV } from './config';
import { SUPABASE_ANON_KEY } from '../../supabase-client.js';

export type ToneType = 'very_formal' | 'professional' | 'warm' | 'direct';
export type LanguageType = 'fr' | 'en';
export type SenderType = 'candidate' | 'me' | 'other';

export interface FocalsSettings {
  user_id: string;
  default_tone: ToneType;
  system_prompt_override?: string | null;
}

export interface FocalsJob {
  id: string;
  user_id: string;
  title: string;
  company: string;
  language: LanguageType;
  raw_description: string;
  summary?: string | null;
  is_default: boolean;
}

export interface FocalsTemplate {
  id: string;
  user_id: string;
  label: string;
  language: LanguageType;
  content: string;
}

export interface ConversationMessage {
  senderType: SenderType;
  text: string;
  timestamp?: string;
  createdAt?: string;
}

export interface FocalsBootstrapResponse {
  userId: string;
  settings: FocalsSettings;
  templates: FocalsTemplate[];
}

export interface FocalsGetDataResponse {
  userId: string;
  settings: FocalsSettings;
  templates: FocalsTemplate[];
}

export interface GenerateReplyRequest {
  userId: string;
  messages: ConversationMessage[];
  context?: {
    language?: LanguageType;
    tone?: ToneType;
    candidateName?: string | null;
    linkedinProfile?: Record<string, unknown> | null;
    systemPromptOverride?: string | null;
  };
  toneOverride?: ToneType;
  jobId?: string;
  templateId?: string | null;
  templateContentOverride?: string | null;
}

export interface GenerateReplyResponse {
  reply?: {
    text: string;
    meta?: Record<string, unknown>;
  };
  /**
   * Legacy field kept for backward compatibility with older edge function responses.
   */
  replyText?: string;
}

const TALENTBASE_API_URL =
  'https://ppawceknsedxaejpeylu.supabase.co/functions/v1/save-engineer';
const FOCALS_APP_BASE = 'https://mvp-recrutement.lovable.app';

const buildApiUrl = (endpoint = '') => {
  const normalizedBase = API_BASE_URL.replace(/\/?$/, '');
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${normalizedBase}${normalizedEndpoint}`;
};

async function postJson<TResponse>(endpoint: string, payload: unknown): Promise<TResponse> {
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
    const errorDetail = (body as any)?.error || (body as any)?.message || (typeof body === 'string' && body ? body : '');
    const message = errorDetail ? `HTTP ${res.status}: ${errorDetail}` : `HTTP ${res.status}`;
    if (IS_DEV) {
      console.error('[FOCALS][API][ERROR]', { url, status: res.status, message, payload });
    }
    throw new Error(message);
  }

  if (IS_DEV) {
    console.log('[FOCALS][API][RESPONSE]', { url, status: res.status });
  }

  return body as TResponse;
}

export async function bootstrapUser(userId: string): Promise<FocalsBootstrapResponse> {
  return postJson('focals-bootstrap-user', { userId });
}

export async function getAllData(userId: string): Promise<FocalsGetDataResponse> {
  return postJson('focals-get-data', { userId });
}

export async function upsertSettings(
  userId: string,
  partial: Partial<Pick<FocalsSettings, 'default_tone' | 'system_prompt_override'>>
): Promise<FocalsSettings> {
  const payload: Record<string, unknown> = { userId };
  if (partial && Object.prototype.hasOwnProperty.call(partial, 'default_tone')) {
    payload.default_tone = partial.default_tone;
  }
  if (partial && Object.prototype.hasOwnProperty.call(partial, 'system_prompt_override')) {
    payload.system_prompt_override = partial.system_prompt_override;
  }
  return postJson('focals-upsert-settings', payload);
}

export async function upsertTemplate(
  userId: string,
  templateInput: { id?: string; label: string; language: LanguageType; content: string }
): Promise<FocalsTemplate> {
  return postJson('focals-upsert-template', { userId, template: templateInput });
}

export async function deleteTemplate(
  userId: string,
  templateId: string
): Promise<{ success: true }> {
  return postJson('focals-delete-template', { userId, templateId });
}

export async function generateReply(request: GenerateReplyRequest): Promise<GenerateReplyResponse> {
  return postJson('focals-generate-reply', request);
}

export async function generateFollowup(
  request: GenerateReplyRequest
): Promise<GenerateReplyResponse> {
  return postJson('focals-generate-reply', request);
}

export async function associateProfile(profile: unknown, accessToken: string, userId: string) {
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

export async function exportProfileToTalentBase(payload: {
  userId?: string;
  profile: unknown;
  exportedAt?: string;
}): Promise<unknown> {
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
      (responseBody && (responseBody as any).error) ||
      (typeof responseBody === 'string' && responseBody) ||
      `HTTP ${res.status}`;
    throw new Error(errorMessage as string);
  }

  return responseBody;
}

export const __private = { postJson, API_BASE_URL };

