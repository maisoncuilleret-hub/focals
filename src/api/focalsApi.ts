import { API_BASE_URL } from './config';

export type ToneType = 'very_formal' | 'professional' | 'warm' | 'direct';
export type LanguageType = 'fr' | 'en';
export type ReplyMode = 'initial' | 'followup_soft' | 'followup_strong';
export type SenderType = 'candidate' | 'me' | 'other';

export interface FocalsSettings {
  user_id: string;
  default_tone: ToneType;
  default_job_id: string | null;
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
  createdAt: string;
}

export interface FocalsBootstrapResponse {
  userId: string;
  settings: FocalsSettings;
  jobs: FocalsJob[];
  templates: FocalsTemplate[];
}

export interface FocalsGetDataResponse {
  userId: string;
  settings: FocalsSettings;
  jobs: FocalsJob[];
  templates: FocalsTemplate[];
}

export interface GenerateReplyRequest {
  userId: string;
  mode: ReplyMode;
  conversation: {
    messages: ConversationMessage[];
    candidateFirstName?: string | null;
    language: LanguageType;
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

async function callFocalsAPI<TResponse>(endpoint: string, payload: unknown): Promise<TResponse> {
  const res = await fetch(`${API_BASE_URL}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let errorMessage = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if ((data as any)?.error) errorMessage = (data as any).error;
    } catch (err) {
      // ignore JSON parse error
    }
    console.error(`[Focals API] ${endpoint} error:`, errorMessage);
    throw new Error(errorMessage);
  }

  return res.json() as Promise<TResponse>;
}

export async function bootstrapUser(userId: string): Promise<FocalsBootstrapResponse> {
  return callFocalsAPI('focals-bootstrap-user', { userId });
}

export async function getAllData(userId: string): Promise<FocalsGetDataResponse> {
  return callFocalsAPI('focals-get-data', { userId });
}

export async function upsertSettings(
  userId: string,
  partial: Partial<Pick<FocalsSettings, 'default_tone' | 'default_job_id'>>
): Promise<FocalsSettings> {
  return callFocalsAPI('focals-upsert-settings', { userId, ...partial });
}

export async function upsertJob(
  userId: string,
  jobInput: {
    id?: string;
    title: string;
    company: string;
    language: LanguageType;
    raw_description: string;
    summary?: string | null;
    is_default?: boolean;
  }
): Promise<FocalsJob> {
  return callFocalsAPI('focals-upsert-job', { userId, job: jobInput });
}

export async function deleteJob(userId: string, jobId: string): Promise<{ success: true }> {
  return callFocalsAPI('focals-delete-job', { userId, jobId });
}

export async function upsertTemplate(
  userId: string,
  templateInput: { id?: string; label: string; language: LanguageType; content: string }
): Promise<FocalsTemplate> {
  return callFocalsAPI('focals-upsert-template', { userId, template: templateInput });
}

export async function deleteTemplate(
  userId: string,
  templateId: string
): Promise<{ success: true }> {
  return callFocalsAPI('focals-delete-template', { userId, templateId });
}

export async function generateReply(request: GenerateReplyRequest): Promise<GenerateReplyResponse> {
  return callFocalsAPI('focals-generate-reply', request);
}

export const __private = { callFocalsAPI, API_BASE_URL };
import { API_BASE_URL } from './config';

