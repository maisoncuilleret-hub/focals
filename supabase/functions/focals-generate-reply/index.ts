import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
type Mode = "initial" | "followup_soft" | "followup_strong" | "prompt_reply" | "auto" | string;
type LinkedInExperience = {
  title?: string;
  company?: string;
  start?: string;
  end?: string;
  workplaceType?: string | null;
  description?: string;
  descriptionBullets?: string[];
};
type LinkedInProfile = {
  url?: string;
  headline?: string;
  currentRole?: {
    title?: string;
    company?: string;
  };
  experiences?: LinkedInExperience[];
};
type JobContext = {
  title?: string;
  description?: string;
  keywords?: string[];
};
type TemplateContext = {
  content?: string;
};
type Message = {
  text?: string;
  fromMe?: boolean;
  senderType?: string;
  timestampRaw?: string;
  timestamp?: string;
};
type FormatARequestBody = {
  userId?: string;
  mode?: Mode;
  messages?: Message[];
  context?: {
    language?: string;
    tone?: string;
    candidateName?: string;
    job?: JobContext;
    template?: TemplateContext;
    linkedinProfile?: LinkedInProfile;
  };
  customInstructions?: string;
  promptReply?: string;
  systemPromptOverride?: string | null;
};
type FormatBRequestBody = {
  userId?: string;
  mode?: Mode;
  conversation?: {
    messages?: Message[];
    language?: string;
    candidateFirstName?: string;
  };
  toneOverride?: string;
  jobId?: string;
  templateId?: string;
  promptReply?: string;
  systemPromptOverride?: string | null;
};
type PromptContext = {
  mode: Mode;
  conversationText: string;
  language: string;
  tone: string;
  candidateName?: string;
  job?: JobContext;
  template?: TemplateContext;
  linkedinProfile?: LinkedInProfile;
  customInstructions?: string;
  promptReply?: string;
  shouldPersonalizeWithLinkedIn: boolean;
  systemPromptOverride?: string | null;
};
type UserSettings = {
  user_id: string;
  default_tone?: string | null;
  system_prompt_override?: string | null;
};
const OPENAI_MODEL = "gpt-4o-mini";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;
const isFollowupMode = (mode: Mode, messages: Message[] = []): boolean => {
  if (mode === "followup_soft" || mode === "followup_strong") return true;
  if (mode === "auto") {
    return messages.some((m) => m && m.text && m.fromMe === false);
  }
  return false;
};
const formatConversation = (messages: Message[] = []): string => {
  const meaningful = (messages || []).filter((m) => m?.text);
  return meaningful
    .map((msg) => `${msg.fromMe || msg.senderType === "me" ? "Moi" : "Candidat"}: ${msg.text}`)
    .join("\n");
};
const summarizeLinkedInProfile = (
  profile?: LinkedInProfile,
  candidateName?: string,
): string | null => {
  if (!profile) return null;
  const lines: string[] = ["Profil LinkedIn du candidat:"];
  if (candidateName) lines.push(`- Nom: ${candidateName}`);
  if (profile.url) lines.push(`- URL: ${profile.url}`);
  if (profile.headline) lines.push(`- Headline: ${profile.headline}`);
  if (profile.currentRole?.title || profile.currentRole?.company) {
    const title = profile.currentRole?.title || "Poste actuel";
    const company = profile.currentRole?.company ? ` @ ${profile.currentRole.company}` : "";
    lines.push(`- Poste actuel: ${title}${company}`);
  }
  const experiences = profile.experiences?.filter((exp) => exp.title || exp.company) || [];
  const recentExperiences = experiences.slice(0, 4);
  if (recentExperiences.length) {
    lines.push("- Expériences récentes:");
    recentExperiences.forEach((exp, idx) => {
      const title = exp.title || "Expérience";
      const company = exp.company ? ` @ ${exp.company}` : "";
      const start = exp.start || "";
      const end = exp.end || "";
      const dates = start || end ? ` (${start || "?"} – ${end || "?"})` : "";
      lines.push(`  ${idx + 1}) ${title}${company}${dates}`);
    });
  }
  return lines.join("\n");
};
const getUserSettings = async (userId?: string): Promise<UserSettings | null> => {
  if (!userId || !supabase) return null;
  try {
    const { data, error } = await supabase
      .from("user_settings")
      .select("user_id, default_tone, system_prompt_override")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      console.error("[Focals][API] Unable to fetch user settings", { error: error.message, userId });
      return null;
    }
    return data as UserSettings;
  } catch (err) {
    console.error("[Focals][API] Unexpected error while fetching settings", err);
    return null;
  }
};
const buildPromptMessages = (ctx: PromptContext) => {
  const {
    mode,
    conversationText,
    language,
    tone,
    candidateName,
    job,
    template,
    linkedinProfile,
    customInstructions,
    promptReply,
    shouldPersonalizeWithLinkedIn,
    systemPromptOverride,
  } = ctx;
  const linkedinSummary = summarizeLinkedInProfile(linkedinProfile, candidateName);
  const jobSummary = job?.title || job?.description
    ? `Fiche de poste:
- Titre: ${job?.title || "(titre manquant)"}
- Description: ${job?.description || "(description manquante)"}
${job?.keywords?.length ? `- Mots-clés: ${job?.keywords.join(", ")}` : ""}`
    : null;
  const templateNote = template?.content ? `Template suggéré: ${template.content}` : null;
  const baseSystemPrompt = [
    "Tu es un recruteur spécialisé dans les profils tech.",
    "Tu reçois: l'historique de la conversation LinkedIn, une fiche de poste, et éventuellement un résumé du profil LinkedIn du candidat.",
    `Réponds en ${language === "en" ? "anglais" : "français"} avec un ton ${tone || "professionnel"}.`,
    "Ta réponse doit rester concise (5–8 lignes) et orientée prise de rendez-vous.",
  ].join("\n");
  const finalSystemPrompt = (systemPromptOverride || "").trim()
    ? `${baseSystemPrompt}\n\nRègles spécifiques pour cet utilisateur :\n${(systemPromptOverride || "").trim()}`
    : baseSystemPrompt;
  const userBlocks: string[] = [];
  userBlocks.push(`Langue souhaitée : ${language === "en" ? "anglais" : "français"}`);
  if (tone) userBlocks.push(`Ton souhaité : ${tone}`);
  if (conversationText) userBlocks.push(`Historique de conversation:\n${conversationText}`);
  if (jobSummary) userBlocks.push(jobSummary);
  if (linkedinSummary) userBlocks.push(linkedinSummary);
  if (templateNote) userBlocks.push(templateNote);
  if (customInstructions) {
    userBlocks.push(`Instructions supplémentaires : ${customInstructions}`);
  }
  const userInstruction =
    mode === "prompt_reply"
      ? promptReply || customInstructions || "Rédige la meilleure réponse possible en suivant les consignes ci-dessus."
      : `Génère une réponse LinkedIn pour le mode ${mode}. Reste naturel et orienté prise de rendez-vous.`;
  userBlocks.push(userInstruction);
  const messages: { role: "system" | "assistant" | "user"; content: string }[] = [
    { role: "system", content: finalSystemPrompt },
    { role: "user", content: userBlocks.filter(Boolean).join("\n\n") },
  ];
  if (shouldPersonalizeWithLinkedIn && linkedinSummary) {
    messages.push({
      role: "assistant",
      content:
        "Rappelle-toi de citer au moins une expérience précise du candidat et de relier son parcours à la fiche de poste sans inventer d'informations.",
    });
  }
  return messages;
};
const callOpenAI = async (messages: { role: string; content: string }[]) => {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.6,
    }),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    console.error("[Focals][API] OpenAI error", errorBody);
    throw new Error("OpenAI request failed");
  }
  const json = await response.json();
  const replyText = json?.choices?.[0]?.message?.content?.trim();
  return replyText;
};
serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  let body: FormatARequestBody | FormatBRequestBody;
  try {
    body = await req.json();
  } catch (_err) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const isFormatA = (body as FormatARequestBody)?.context !== undefined || (body as FormatARequestBody)?.messages !== undefined;
  const mode = (body as FormatARequestBody).mode || (body as FormatBRequestBody).mode;
  if (!mode) {
    return new Response(JSON.stringify({ error: "mode is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    if (isFormatA) {
      const {
        userId,
        messages = [],
        context = {},
        customInstructions,
        promptReply,
        systemPromptOverride,
      } = body as FormatARequestBody;
      const userSettings = await getUserSettings(userId);
      console.log("[Focals][API] /focals-generate-reply body", {
        mode,
        hasLinkedinProfile: !!context?.linkedinProfile,
        candidateName: context?.candidateName,
        language: context?.language,
      });
      const conversationText = formatConversation(messages);
      const language = context?.language || "fr";
      const tone = context?.tone || userSettings?.default_tone || "professionnel";
      const systemOverride = systemPromptOverride || userSettings?.system_prompt_override || null;
      const shouldPersonalize = isFollowupMode(mode, messages) && !!context?.linkedinProfile && !!context?.job;
      const promptMessages = buildPromptMessages({
        mode,
        conversationText,
        language,
        tone,
        candidateName: context?.candidateName,
        job: context?.job,
        template: context?.template,
        linkedinProfile: context?.linkedinProfile,
        customInstructions,
        promptReply,
        shouldPersonalizeWithLinkedIn: shouldPersonalize,
        systemPromptOverride: systemOverride,
      });
      const replyText = await callOpenAI(promptMessages);
      return new Response(JSON.stringify({ replyText, model: OPENAI_MODEL }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const {
      conversation,
      toneOverride,
      promptReply,
      userId,
      systemPromptOverride,
    } = body as FormatBRequestBody;
    const userSettings = await getUserSettings(userId);
    const messages = Array.isArray(conversation?.messages) ? conversation?.messages : [];
    const conversationText = formatConversation(messages);
    const language = conversation?.language || "fr";
    const tone = toneOverride || userSettings?.default_tone || "professionnel";
    const candidateName = conversation?.candidateFirstName;
    console.log("[Focals][API] /focals-generate-reply body (format B)", {
      mode,
      userId: userId || "(anonymous)",
      language,
      messageCount: messages.length,
    });
    const shouldPersonalize = isFollowupMode(mode, messages);
    const promptMessages = buildPromptMessages({
      mode,
      conversationText,
      language,
      tone,
      candidateName,
      job: undefined,
      template: undefined,
      linkedinProfile: undefined,
      customInstructions: undefined,
      promptReply,
      shouldPersonalizeWithLinkedIn: shouldPersonalize,
      systemPromptOverride: systemPromptOverride || userSettings?.system_prompt_override || null,
    });
    const replyText = await callOpenAI(promptMessages);
    return new Response(JSON.stringify({ replyText, model: OPENAI_MODEL }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[Focals][API] error", error);
    return new Response(JSON.stringify({ error: error?.message || "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
