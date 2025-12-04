import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

type Mode = "initial" | "followup_soft" | "followup_strong" | "prompt_reply" | "auto" | string;

type LinkedInExperience = {
  title?: string;
  company?: string;
  start?: string;
  end?: string;
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
};

const OPENAI_MODEL = "gpt-4o-mini";

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
  } = ctx;

  const linkedinSummary = summarizeLinkedInProfile(linkedinProfile, candidateName);
  const jobSummary = job?.title || job?.description
    ? `Fiche de poste:
- Titre: ${job?.title || "(titre manquant)"}
- Description: ${job?.description || "(description manquante)"}
${job?.keywords?.length ? `- Mots-clés: ${job?.keywords.join(", ")}` : ""}`
    : null;

  const templateNote = template?.content ? `Template suggéré: ${template.content}` : null;

  const systemParts: string[] = [
    "Tu es un recruteur spécialisé dans les profils tech.",
    "Tu reçois: l'historique de la conversation LinkedIn, une fiche de poste, et éventuellement un résumé du profil LinkedIn du candidat.",
    `Réponds en ${language === "en" ? "anglais" : "français"} avec un ton ${tone || "professionnel"}.`,
    "Ta réponse doit rester concise (5–8 lignes) et orientée prise de rendez-vous.",
  ];

  if (shouldPersonalizeWithLinkedIn && linkedinSummary) {
    systemParts.push(
      "Quand `linkedinProfile` est présent, ta réponse doit être clairement PERSONNALISÉE:",
      "- Cite au moins une expérience, entreprise ou intitulé de poste exact du candidat.",
      "- Fais le lien explicite entre ce parcours et la fiche de poste.",
      "- Exemple de style attendu: \"Ton expérience de Head of Backend chez BeReal, après un passage comme Tech Lead, est très proche de ce qu’on cherche pour ce poste d’Engineering Manager chez Joko...\"",
      "Ne fabrique pas d’expériences ou de boîtes qui ne figurent pas dans `linkedinProfile` ou dans la fiche de poste.",
      "Ne copie pas mot pour mot la description du profil, mais reformule.",
    );
  }

  const messages: { role: "system" | "assistant" | "user"; content: string }[] = [
    { role: "system", content: systemParts.join("\n") },
  ];

  const assistantBlocks: string[] = [];
  if (conversationText) assistantBlocks.push(`Historique de conversation:\n${conversationText}`);
  if (jobSummary) assistantBlocks.push(jobSummary);
  if (linkedinSummary) assistantBlocks.push(linkedinSummary);
  if (templateNote) assistantBlocks.push(templateNote);
  if (customInstructions) assistantBlocks.push(`Consignes personnalisées: ${customInstructions}`);

  if (assistantBlocks.length) {
    messages.push({ role: "assistant", content: assistantBlocks.join("\n\n") });
  }

  if (mode === "prompt_reply") {
    messages.push({
      role: "user",
      content:
        promptReply || customInstructions || "Rédige la meilleure réponse possible en suivant les consignes ci-dessus.",
    });
  } else {
    messages.push({
      role: "user",
      content: `Génère une réponse LinkedIn pour le mode ${mode}. Reste naturel et orienté vers la prise de rendez-vous.`,
    });
  }

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
        messages = [],
        context = {},
        customInstructions,
        promptReply,
      } = body as FormatARequestBody;

      console.log("[Focals][API] /focals-generate-reply body", {
        mode,
        hasLinkedinProfile: !!context?.linkedinProfile,
        candidateName: context?.candidateName,
        language: context?.language,
      });

      const conversationText = formatConversation(messages);
      const language = context?.language || "fr";
      const tone = context?.tone || "professionnel";
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
    } = body as FormatBRequestBody;

    const messages = Array.isArray(conversation?.messages) ? conversation?.messages : [];
    const conversationText = formatConversation(messages);
    const language = conversation?.language || "fr";
    const tone = toneOverride || "professionnel";
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
