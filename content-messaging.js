(() => {
  const FOCALS_DEBUG = false;

  function debugLog(stage, details) {
    if (!FOCALS_DEBUG) return;
    try {
      if (typeof details === "string") {
        console.log(`[Focals][MSG][${stage}]`, details);
      } else {
        console.log(`[Focals][MSG][${stage}]`, JSON.stringify(details, null, 2));
      }
    } catch (e) {
      console.log(`[Focals][MSG][${stage}]`, details);
    }
  }

  function sendApiRequest({ endpoint, method = "GET", body, params }) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "API_REQUEST", endpoint, method, body, params },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response?.ok) {
            reject(new Error(response?.error || "API request failed"));
            return;
          }
          resolve(response.data);
        }
      );
    });
  }

  const env = {
    href: window.location.href,
    origin: window.location.origin,
    isTop: window === window.top,
    isSandbox:
      document.origin === "null" ||
      window.location.origin === "null" ||
      !!window.frameElement?.hasAttribute("sandbox"),
  };

  if (!env.isTop) {
    debugLog("EXIT", "Not in top window, exiting messaging script");
    return;
  }
  if (env.isSandbox) {
    debugLog("EXIT", "Sandboxed document, skipping messaging script");
    return;
  }

  // Prevent double injection
  if (window.__FOCALS_MESSAGING_LOADED__) {
    debugLog("EXIT", "content-messaging.js already initialized");
    return;
  }
  window.__FOCALS_MESSAGING_LOADED__ = true;

  debugLog("INIT", env);

  try {

    const EDITOR_SELECTOR = "div.msg-form__contenteditable";
    const BUTTON_CLASS = "focals-suggest-reply-button";
    const FOCALS_GENERATE_REPLY_ENDPOINT = "/focals-generate-reply";
    const STORAGE_KEYS = {
      settings: "FOCALS_SETTINGS",
      templates: "FOCALS_TEMPLATES",
      activeTemplate: "FOCALS_ACTIVE_TEMPLATE",
      jobs: "FOCALS_JOBS",
      activeJob: "FOCALS_ACTIVE_JOB",
    };
    const PROFILE_STORAGE_KEY = "FOCALS_LAST_PROFILE";

    const USER_ID_STORAGE_KEY = "focals_user_id";
    let cachedUserId = null;

    const getOrCreateUserId = async () => {
      if (cachedUserId) return cachedUserId;
      return new Promise((resolve, reject) => {
        try {
          chrome.storage.local.get([USER_ID_STORAGE_KEY], (result) => {
            const existing = result?.[USER_ID_STORAGE_KEY];
            if (existing && typeof existing === "string") {
              cachedUserId = existing;
              resolve(existing);
              return;
            }
            const newId = crypto.randomUUID();
            chrome.storage.local.set({ [USER_ID_STORAGE_KEY]: newId }, () => {
              cachedUserId = newId;
              resolve(newId);
            });
          });
        } catch (err) {
          reject(err);
        }
      });
    };

    const DEFAULT_SETTINGS = {
      tone: "friendly",
      languageFallback: "en",
      followUpPreference: "next_steps",
    };

    const DEFAULT_TEMPLATES = [
      {
        id: "friendly_followup",
        title: "Friendly follow-up",
        content:
          "Remercie pour le message, réponds brièvement et propose la prochaine étape (appel ou échange). Reste concis et accessible.",
      },
      {
        id: "concise_ack",
        title: "Concise acknowledgement",
        content:
          "Accuse réception, reprends un élément clé du message précédent et propose une action claire en deux phrases maximum.",
      },
    ];

    const DEFAULT_JOBS = [
      {
        id: "default_job",
        title: "Full-Stack Engineer",
        description:
          "We are hiring a pragmatic full-stack engineer who can ship end-to-end features with React/TypeScript and Node. Emphasis on ownership, clean communication, and shipping reliable customer-facing features.",
        keywords: ["React", "TypeScript", "Node", "shipping", "customer focus"],
      },
    ];

    const normalizeText = (text = "") => text.replace(/\s+/g, " ").trim();

    const log = (message, ...args) => {
      if (FOCALS_DEBUG) {
        debugLog("LOG", { message, args });
      }
    };

    const warn = (message, ...args) => {
      if (FOCALS_DEBUG) {
        debugLog("WARN", { message, args });
      }
    };

    const error = (message, ...args) => {
      console.error("[Focals][MSG][ERROR]", message, ...args);
    };

    const getFromStorage = (area, defaults = {}) =>
      new Promise((resolve) => {
        try {
          chrome.storage[area].get(defaults, (result) => {
            resolve(result || defaults);
          });
        } catch (err) {
          warn("STORAGE_GET_ERROR", err?.message || err);
          resolve(defaults);
        }
      });

    const setInStorage = (area, values = {}) =>
      new Promise((resolve) => {
        try {
          chrome.storage[area].set(values, () => resolve(true));
        } catch (err) {
          warn("STORAGE_SET_ERROR", err?.message || err);
          resolve(false);
        }
      });

    const detectLanguageFromMessages = (messages = [], fallback = "en") => {
      const joined = normalizeText(messages.map((m) => m.text || "").join(" ")).toLowerCase();
      if (!joined) return fallback;

      const frenchSignals = [/\bbonjour|merci|disponible|avec plaisir|prochaine\b/, /\bpropos|sujet|échange|rendez-vous\b/];
      const englishSignals = [/\bhello|thanks|thank you|available|meeting|schedule\b/, /\bappreciate|talk|chat|call\b/];

      const scoreSignals = (signals) => signals.reduce((score, regex) => (regex.test(joined) ? score + 1 : score), 0);

      const frScore = scoreSignals(frenchSignals);
      const enScore = scoreSignals(englishSignals);

      if (frScore === 0 && enScore === 0) return fallback;
      return frScore >= enScore ? "fr" : "en";
    };

    const detectCandidateName = (conversationName = "", messages = []) => {
      const cleaned = normalizeText(conversationName).replace(/\s*\([^)]*\)/g, "");
      const delimiters = ["|", "·", "•", "-", "—", " avec ", " with "];
      for (const delimiter of delimiters) {
        if (cleaned.includes(delimiter)) {
          const part = cleaned.split(delimiter)[0].trim();
          if (part) return part;
        }
      }

      if (cleaned) return cleaned;

      const firstIncoming = messages.find((m) => !m.fromMe && m.text);
      if (!firstIncoming) return "";
      const match = firstIncoming.text.match(/bonjour\s+([A-ZÉÈÎÏÂÊÔÛÇ][\w-]+)/i);
      if (match && match[1]) {
        return match[1];
      }

      return "";
    };

    const extractKeywordsFromJob = (description = "") => {
      if (!description) return [];
      const tokens = description
        .split(/[^A-Za-zÀ-ÿ0-9+#]+/)
        .map((word) => word.trim())
        .filter((word) => word.length >= 3 && word.length <= 30);

      const interesting = tokens.filter((token) => {
        const hasUpper = /[A-Z]/.test(token.charAt(0));
        const isTech = /[+#]/.test(token) || /js|dev|tech|data/i.test(token);
        return hasUpper || isTech;
      });

      return Array.from(new Set(interesting)).slice(0, 15);
    };

    const buildJobContext = (job) => {
      if (!job) return null;
      const description = job.raw_description || job.summary || job.description || "";
      const keywords = Array.isArray(job.keywords) && job.keywords.length
        ? job.keywords
        : extractKeywordsFromJob(description);
      return {
        title: job.title || job.label || job.id || "",
        description,
        keywords,
      };
    };

    const extractCandidateProfileFromPage = (rootElement = document) => {
      const urlFromLocation = /linkedin\.com\/in\//i.test(window.location.href)
        ? window.location.href.split(/[?#]/)[0]
        : null;

      const profileAnchor =
        rootElement.querySelector("a[href*='/in/']") ||
        document.querySelector("a[href*='/in/']");

      const candidateProfileUrl =
        profileAnchor?.href?.split(/[?#]/)[0] || urlFromLocation || null;

      const candidateProfileSummary = null;

      debugLog("PROFILE_RESOLVE", { candidateProfileUrl, hasAnchor: !!profileAnchor });

      return { candidateProfileUrl, candidateProfileSummary };
    };

    const getCachedProfileFromStorage = () =>
      new Promise((resolve) => {
        try {
          chrome.storage.local.get([PROFILE_STORAGE_KEY], (result) => {
            resolve(result?.[PROFILE_STORAGE_KEY] || null);
          });
        } catch (err) {
          warn("PROFILE_CACHE_READ_ERROR", err?.message || err);
          resolve(null);
        }
      });

    const buildLinkedinProfileContext = (profile, fallbackUrl = null) => {
      if (!profile && !fallbackUrl) return null;
      const experiences = Array.isArray(profile?.experiences) ? profile.experiences.slice(0, 5) : [];
      const normalizedExperiences = experiences
        .filter((exp) => exp && (exp.title || exp.company))
        .map((exp) => ({
          title: exp.title || "",
          company: exp.company || "",
          start: exp.start || "",
          end: exp.end || "",
          location: exp.location || "",
        }));

      const headline = profile?.headline || profile?.current_title || profile?.title || "";
      const currentRoleTitle = profile?.current_title || "";
      const currentRoleCompany = profile?.current_company || "";

      let url = profile?.linkedin_url || profile?.url || fallbackUrl || null;
      if (!url && profile?.profile_slug) {
        url = /^https?:/i.test(profile.profile_slug)
          ? profile.profile_slug
          : `https://www.linkedin.com/in/${profile.profile_slug}`;
      }

      return {
        url,
        headline,
        currentRole:
          currentRoleTitle || currentRoleCompany
            ? { title: currentRoleTitle || "", company: currentRoleCompany || "" }
            : undefined,
        experiences: normalizedExperiences,
      };
    };

    const resolveLinkedinProfileContext = async (rootElement = document) => {
      const pageProfile = extractCandidateProfileFromPage(rootElement);
      const cachedProfile = await getCachedProfileFromStorage();
      const linkedinProfile = buildLinkedinProfileContext(
        cachedProfile,
        pageProfile?.candidateProfileUrl || null
      );

      return { linkedinProfile, cachedProfile, candidateProfileUrl: pageProfile?.candidateProfileUrl };
    };

    const loadUserPreferences = async () => {
      const [syncData, localData] = await Promise.all([
        getFromStorage("sync", {
          [STORAGE_KEYS.settings]: DEFAULT_SETTINGS,
          [STORAGE_KEYS.templates]: DEFAULT_TEMPLATES,
          [STORAGE_KEYS.activeTemplate]: DEFAULT_TEMPLATES[0].id,
        }),
        getFromStorage("local", {
          [STORAGE_KEYS.jobs]: DEFAULT_JOBS,
          [STORAGE_KEYS.activeJob]: DEFAULT_JOBS[0].id,
        }),
      ]);

      const settings = { ...DEFAULT_SETTINGS, ...(syncData?.[STORAGE_KEYS.settings] || {}) };

      const templates = Array.isArray(syncData?.[STORAGE_KEYS.templates])
        ? syncData[STORAGE_KEYS.templates]
        : DEFAULT_TEMPLATES;

      const activeTemplateId = syncData?.[STORAGE_KEYS.activeTemplate] || templates?.[0]?.id;
      const activeTemplate = templates.find((tpl) => tpl.id === activeTemplateId) || templates[0];

      if (!syncData?.[STORAGE_KEYS.templates]) {
        await setInStorage("sync", {
          [STORAGE_KEYS.templates]: templates,
          [STORAGE_KEYS.activeTemplate]: activeTemplate?.id,
        });
      }

      const jobs = Array.isArray(localData?.[STORAGE_KEYS.jobs]) ? localData[STORAGE_KEYS.jobs] : DEFAULT_JOBS;
      const activeJobId = localData?.[STORAGE_KEYS.activeJob] || jobs?.[0]?.id;
      const activeJob = jobs.find((job) => job.id === activeJobId) || jobs[0];

      if (!localData?.[STORAGE_KEYS.jobs]) {
        await setInStorage("local", {
          [STORAGE_KEYS.jobs]: jobs,
          [STORAGE_KEYS.activeJob]: activeJob?.id,
        });
      }

      return { settings, templates, activeTemplate, jobs, activeJob };
    };

    const resolveConversationRoot = (composer) => {
      const messageSelector =
        'div.msg-s-event-listitem[data-view-name="message-list-item"]';

      const rootSelectors = [
        "section.msg-thread",
        ".msg-overlay-conversation-bubble",
        "section.msg-conversation-container",
        "div.msg-thread",
      ];

      for (const selector of rootSelectors) {
        const root = composer.closest(selector);
        if (root) return root;
      }

      let current = composer;
      while (current && current !== document.documentElement) {
        if (current.querySelector && current.querySelector(messageSelector)) {
          return current;
        }
        current = current.parentElement;
      }

      warn(
        "[CONTEXT] Unable to resolve a specific conversation root, falling back to document"
      );
      return document;
    };

    const resolveConversationName = (rootElement) => {
      const nameSelectors = [
        ".msg-overlay-bubble-header__title",
        ".msg-thread__name",
        ".msg-thread__link",
        ".msg-s-message-group__name",
        ".msg-entity-lockup__entity-title",
      ];

      for (const selector of nameSelectors) {
        const node = rootElement.querySelector(selector);
        const text = normalizeText(node?.textContent || "");
        if (text) return text;
      }

      return "Unknown conversation";
    };

    const extractLinkedInMessages = (rootElement = document) => {
      const usingDocument = rootElement === document;
      log(
        `[SCRAPE] Using ${usingDocument ? "document" : "scoped root"} for messages`
      );

      const messageNodes = Array.from(
        rootElement.querySelectorAll(
          'div.msg-s-event-listitem[data-view-name="message-list-item"]'
        )
      );

      log(
        `[SCRAPE] Found ${messageNodes.length} message items${
          usingDocument ? "" : " in scoped conversation root"
        }`
      );

      if (!messageNodes.length && !usingDocument) {
        warn("[SCRAPE] No messages found in scoped root, not falling back to document");
      }

      const allMessages = [];

      messageNodes.forEach((container) => {
        const body = container.querySelector("p.msg-s-event-listitem__body");
        const text = normalizeText(body?.innerText || "");

        if (!text) {
          log("[SCRAPE] No body text for this message, skipping");
          return;
        }

        const fromMe = !container.classList.contains("msg-s-event-listitem--other");
        log(`[SCRAPE] Message role resolved: fromMe = ${fromMe}`);

        let timestampRaw = "";
        const titleNode = container.querySelector(
          "span.msg-s-event-with-indicator__sending-indicator[title]"
        );
        if (titleNode?.getAttribute("title")) {
          timestampRaw = titleNode.getAttribute("title") || "";
          log(`[SCRAPE] Timestamp title found: "${timestampRaw}"`);
        }

        if (!timestampRaw) {
          const fallbackTime = container.querySelector("time.msg-s-message-group__timestamp");
          const fallbackText = normalizeText(fallbackTime?.innerText || "");
          if (fallbackText) {
            timestampRaw = fallbackText;
            log(`[SCRAPE] Using fallback timestamp from <time>: "${timestampRaw}"`);
          }
        }

        const message = {
          text,
          fromMe,
          timestampRaw,
        };

        log("[SCRAPE] Built message object:", {
          fromMe,
          length: text.length,
          timestampRaw,
        });

        allMessages.push(message);
      });

      if (!allMessages.length) {
        warn("[SCRAPE] No messages found after parsing");
        return [];
      }

      const recentMessages = allMessages.slice(-3);
      if (allMessages.length > 3) {
        log(`[SCRAPE] Using last 3 messages out of ${allMessages.length}`);
      }

      return recentMessages;
    };

    const generateReplyFromAPI = async (
      messages,
      { mode = "auto", context = {}, customInstructions = null } = {}
    ) => {
      if (!messages?.length) {
        warn("PIPELINE extract_messages: no messages found, aborting");
        return null;
      }

      const payload = {
        mode,
        messages: messages.map((msg) => ({
          text: msg.text,
          fromMe: !!msg.fromMe,
          timestampRaw: msg.timestampRaw || new Date().toISOString(),
        })),
        context,
        customInstructions: customInstructions || null,
      };

      log("PIPELINE api_call: prepared payload", payload);

      try {
        const data = await sendApiRequest({
          endpoint: FOCALS_GENERATE_REPLY_ENDPOINT,
          method: "POST",
          body: payload,
        });

        debugLog("GENERATE_REPLY_RESPONSE", data);

        const replyText = data?.replyText || data?.reply?.text || null;
        const replyPresent = !!replyText;
        log(`PIPELINE api_call: reply present = ${replyPresent}`);

        return replyText || null;
      } catch (err) {
        error(`PIPELINE api_call: network failure`, err);
        return null;
      }
    };

    const insertReplyIntoMessageInput = (
      replyText,
      { composer, conversationName = "Unknown conversation" } = {}
    ) => {
      log(`PIPELINE insert_reply: start`);
      log(
        `PIPELINE insert_reply: targeting scoped composer for "${conversationName}"`
      );

      if (!composer) {
        warn(
          `PIPELINE insert_reply: editor not found inside composer, aborting`
        );
        alert("❌ Impossible de trouver le champ de réponse LinkedIn.");
        return false;
      }

      const inputSelectors = [
        ".msg-form__contenteditable",
        "[data-test-message-input]",
        '.msg-form__message-texteditor [contenteditable="true"]',
        'div[role="textbox"][contenteditable="true"]',
      ];

      let inputField = null;
      for (const selector of inputSelectors) {
        inputField = composer.querySelector(selector);
        if (inputField) break;
      }

      if (!inputField) {
        warn(`PIPELINE insert_reply: editor not found inside composer, aborting`);
        alert("❌ Impossible de trouver le champ de réponse LinkedIn.");
        return false;
      }

      inputField.focus();
      inputField.innerHTML = "";

      document.execCommand("insertText", false, replyText);

      if (!inputField.innerText || !inputField.innerText.trim()) {
        inputField.innerText = replyText;
        inputField.dispatchEvent(new Event("input", { bubbles: true }));
        inputField.dispatchEvent(new Event("change", { bubbles: true }));
      }

      const range = document.createRange();
      const selection = window.getSelection();
      range.selectNodeContents(inputField);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);

      log(`PIPELINE insert_reply: success = true`);
      return true;
    };

    const runSuggestReplyPipeline = async ({
      button,
      conversationRoot = document,
      composer,
      conversationName = "Unknown conversation",
      editorIndex,
      generationMode = "auto",
      customInstructions,
    } = {}) => {
      try {
        log("Suggest reply button clicked");
        log(
          `[MSG] PIPELINE_START { conversation: "${conversationName}", editorIndex: ${
            editorIndex ?? "n/a"
          }, usingScopedRoot: ${conversationRoot !== document} }`
        );

        log(`PIPELINE extract_messages: start`);
        const messages = extractLinkedInMessages(conversationRoot) || [];
        log(
          `[Focals][MSG] PIPELINE context: { conversation: "${conversationName}", messagesInRoot: ${messages?.length || 0} }`
        );
        log(`PIPELINE extract_messages: done, count = ${messages.length}`);

        if (!messages.length) {
          warn(`PIPELINE extract_messages: no messages found, aborting`);
          alert("❌ Aucun message détecté dans la conversation.");
          return;
        }

        const { settings, activeJob } = await loadUserPreferences();
        const tone = settings?.tone || settings?.default_tone || "warm";
        const language =
          detectLanguageFromMessages(messages, settings.languageFallback || "fr") || "fr";
        const profileResolution = await resolveLinkedinProfileContext(conversationRoot);
        const candidateName =
          profileResolution.cachedProfile?.firstName ||
          profileResolution.cachedProfile?.name ||
          detectCandidateName(conversationName, messages);
        const jobContext = buildJobContext(activeJob);
        const hasOutgoingMessages = messages.some((msg) => msg.fromMe);

        const baseContext = {
          language,
          tone,
        };

        if (candidateName) {
          baseContext.candidateName = candidateName;
        }

        let payloadMode = "auto";
        let payloadContext = { ...baseContext };
        let instructionsToSend = null;

        if (generationMode === "followup_classic") {
          payloadMode = hasOutgoingMessages ? "followup_soft" : "initial";
          if (jobContext) {
            payloadContext.job = jobContext;
          }
        } else if (generationMode === "followup_personalized") {
          payloadMode = "followup_soft";
          if (!jobContext) {
            alert(
              "❌ Aucune fiche de poste sélectionnée. Choisis un job dans les paramètres Focals."
            );
            return;
          }

          const linkedinProfile =
            profileResolution.linkedinProfile ||
            buildLinkedinProfileContext(null, profileResolution.candidateProfileUrl || null);

          if (!linkedinProfile?.url) {
            alert(
              "❌ Profil LinkedIn introuvable. Ouvre le profil candidat pour personnaliser la relance."
            );
            return;
          }

          payloadContext = {
            ...baseContext,
            job: jobContext,
            linkedinProfile,
          };
        } else if (generationMode === "prompt_custom") {
          payloadMode = "prompt_reply";
          const trimmed = (customInstructions || "").trim();
          if (!trimmed) {
            alert("❌ Ajoutez des instructions personnalisées avant de générer.");
            return;
          }
          if (jobContext) {
            payloadContext.job = jobContext;
          }
          payloadContext = {
            ...payloadContext,
            linkedinProfile: profileResolution.linkedinProfile || null,
          };
          instructionsToSend = trimmed;
        }

        console.log("[Focals][MSG] generate payload context", {
          mode: payloadMode,
          context: payloadContext,
        });

        const reply = await generateReplyFromAPI(messages, {
          mode: payloadMode,
          context: payloadContext,
          customInstructions: instructionsToSend,
        });
        console.log("[Focals][MSG] Réponse reçue", {
          hasReply: !!reply,
          mode: payloadMode,
        });
        if (!reply) {
          warn(`PIPELINE api_call: reply missing, aborting`);
          alert("Erreur Focals, réessaie dans quelques secondes.");
          return;
        }

        const inserted = insertReplyIntoMessageInput(reply, {
          composer,
          conversationName,
        });
        log(`PIPELINE insert_reply: success = ${inserted}`);
      } catch (err) {
        error(`PIPELINE_ERROR ${err?.message || err}`);
        alert(`Erreur Focals, réessaie dans quelques secondes.`);
      }
    };

    let scanScheduled = false;

    const scanAndInject = () => {
      const editors = Array.from(document.querySelectorAll(EDITOR_SELECTOR));
      if (editors.length === 0) {
        return;
      }

      editors.forEach((editor, index) => {
        const composer = editor.closest(".msg-form");
        if (!composer) {
          warn("[SCAN] Unable to resolve composer for editor, skipping");
          return;
        }

        const footer = composer.querySelector("footer.msg-form__footer");
        if (!footer) {
          warn("[SCAN] Missing footer in composer, skipping");
          return;
        }

        const rightActions = footer.querySelector(".msg-form__right-actions");
        if (!rightActions) {
          warn("[SCAN] Missing right actions container, skipping");
          return;
        }

        const conversationRoot = resolveConversationRoot(composer);
        const conversationName = resolveConversationName(conversationRoot);

        if (composer.dataset.focalsBound === "true") {
          log(
            `[MSG] BUTTON_BIND_SKIP already bound for this composer (conversation: "${conversationName}")`
          );
          return;
        }

        const buttonRow = document.createElement("div");
        buttonRow.className = BUTTON_CLASS;
        buttonRow.style.display = "flex";
        buttonRow.style.gap = "6px";
        buttonRow.style.marginLeft = "8px";

        const controlsWrapper = document.createElement("div");
        controlsWrapper.style.position = "relative";
        controlsWrapper.style.display = "flex";
        controlsWrapper.style.flexDirection = "column";
        controlsWrapper.style.alignItems = "flex-end";
        controlsWrapper.style.flex = "1";

        const suggestButton = document.createElement("button");
        suggestButton.className = "artdeco-button artdeco-button--1";
        suggestButton.textContent = "Suggest reply";
        suggestButton.style.padding = "6px 10px";
        suggestButton.style.cursor = "pointer";
        suggestButton.style.flex = "1";

        const promptButton = document.createElement("button");
        promptButton.className = "artdeco-button artdeco-button--1";
        promptButton.textContent = "Prompt reply ▾";
        promptButton.style.padding = "6px 10px";
        promptButton.style.cursor = "pointer";
        promptButton.style.flex = "1";
        promptButton.style.background = "#f3f3f3";
        promptButton.style.borderColor = "#d0d0d0";
        promptButton.style.color = "#333";

        const popover = document.createElement("div");
        popover.style.display = "none";
        popover.style.flexDirection = "column";
        popover.style.gap = "12px";
        popover.style.position = "absolute";
        popover.style.bottom = "48px";
        popover.style.right = "0";
        popover.style.width = "360px";
        popover.style.background = "#ffffff";
        popover.style.border = "1px solid #d0d0d0";
        popover.style.borderRadius = "10px";
        popover.style.boxShadow = "0 10px 30px rgba(0, 0, 0, 0.12)";
        popover.style.padding = "14px";
        popover.style.zIndex = "2147483647";

        const closeButton = document.createElement("button");
        closeButton.textContent = "×";
        closeButton.setAttribute("aria-label", "Fermer la modale Focals");
        closeButton.style.position = "absolute";
        closeButton.style.top = "8px";
        closeButton.style.right = "8px";
        closeButton.style.border = "none";
        closeButton.style.background = "transparent";
        closeButton.style.fontSize = "18px";
        closeButton.style.cursor = "pointer";

        const replyState = {
          selectedMode: null,
          promptReply: "",
          isPanelOpen: false,
        };

        const popoverTitle = document.createElement("div");
        popoverTitle.textContent = "Mode de réponse IA";
        popoverTitle.style.fontSize = "14px";
        popoverTitle.style.fontWeight = "600";
        popoverTitle.style.color = "#111827";

        const popoverDescription = document.createElement("div");
        popoverDescription.textContent =
          "Sélectionne un mode de génération pour la réponse LinkedIn.";
        popoverDescription.style.fontSize = "12px";
        popoverDescription.style.color = "#4b5563";
        popoverDescription.style.lineHeight = "1.4";

        const modesContainer = document.createElement("div");
        modesContainer.style.display = "flex";
        modesContainer.style.flexDirection = "column";
        modesContainer.style.gap = "8px";

        const modes = [
          {
            label: "Relance classique",
            value: "followup_classic",
            description: "Generate a followup based only on the conversation context.",
          },
          {
            label: "Relance personnalisée (profil LinkedIn + job)",
            value: "followup_personalized",
            description:
              "Generate a followup that uses the conversation, LinkedIn profile and selected job description.",
          },
          {
            label: "Prompt personnalisé",
            value: "prompt_custom",
            description: "Generate a reply using a custom free-text prompt.",
          },
        ];

        const modeButtons = [];

        modes.forEach(({ label, value, description }) => {
          const modeButton = document.createElement("button");
          modeButton.innerHTML = `<div style="font-weight:700; font-size:13px; color:#0a2540;">${label}</div><div style="font-size:12px; color:#4b5563; font-weight:500;">${description}</div>`;
          modeButton.dataset.value = value;
          modeButton.style.padding = "12px";
          modeButton.style.border = "1px solid #d0d0d0";
          modeButton.style.borderRadius = "12px";
          modeButton.style.background = "#f3f3f3";
          modeButton.style.cursor = "pointer";
          modeButton.style.fontSize = "13px";
          modeButton.style.color = "#111827";
          modeButton.style.fontWeight = "700";
          modeButton.style.textAlign = "left";

          modeButton.addEventListener("click", () => {
            replyState.selectedMode = value;
            console.log("[Focals][MSG] Mode sélectionné", value);
            syncUI();
          });

          modeButtons.push(modeButton);
          modesContainer.appendChild(modeButton);
        });

        const instructionsBlock = document.createElement("div");
        instructionsBlock.style.display = "none";
        instructionsBlock.style.flexDirection = "column";
        instructionsBlock.style.gap = "6px";

        const promptLabel = document.createElement("label");
        promptLabel.textContent = "Instructions personnalisées";
        promptLabel.style.fontSize = "12px";
        promptLabel.style.color = "#4b5563";

        const promptInput = document.createElement("textarea");
        promptInput.placeholder = "Donne des instructions précises à l’IA…";
        promptInput.maxLength = 500;
        promptInput.style.width = "100%";
        promptInput.style.minHeight = "96px";
        promptInput.style.resize = "vertical";
        promptInput.style.padding = "10px";
        promptInput.style.borderRadius = "8px";
        promptInput.style.border = "1px solid #d1d5db";
        promptInput.style.fontSize = "13px";
        promptInput.style.outline = "none";
        promptInput.addEventListener("focus", () => {
          promptInput.style.boxShadow = "0 0 0 2px rgba(14,118,168,0.2)";
        });
        promptInput.addEventListener("blur", () => {
          promptInput.style.boxShadow = "none";
        });

        promptInput.addEventListener("input", () => {
          replyState.promptReply = promptInput.value;
          syncUI();
        });

        instructionsBlock.appendChild(promptLabel);
        instructionsBlock.appendChild(promptInput);

        const promptGenerate = document.createElement("button");
        promptGenerate.textContent = "Générer la réponse";
        promptGenerate.className = "artdeco-button artdeco-button--1";
        promptGenerate.style.width = "100%";
        promptGenerate.style.padding = "10px";
        promptGenerate.style.cursor = "pointer";

        const syncUI = () => {
          modeButtons.forEach((btn) => {
            const isActive = btn.dataset.value === replyState.selectedMode;
            btn.style.background = isActive ? "#0a66c2" : "#f3f3f3";
            btn.style.color = isActive ? "#ffffff" : "#111827";
            btn.style.borderColor = isActive ? "#0a66c2" : "#d0d0d0";
          });

          const shouldShowInstructions = replyState.selectedMode === "prompt_custom";
          instructionsBlock.style.display = shouldShowInstructions ? "flex" : "none";

          const hasValidPrompt = (replyState.promptReply || "").trim().length > 0;
          const hasSelection = !!replyState.selectedMode;
          promptGenerate.disabled =
            !hasSelection || (shouldShowInstructions && !hasValidPrompt);

          popover.style.display = replyState.isPanelOpen ? "flex" : "none";
          promptButton.style.background = replyState.isPanelOpen ? "#e5e7eb" : "#f3f3f3";
          promptButton.style.borderColor = replyState.isPanelOpen ? "#a3a3a3" : "#d0d0d0";
          promptButton.textContent = replyState.isPanelOpen
            ? "Prompt reply ▴"
            : "Prompt reply ▾";
        };

        const closePanel = () => {
          replyState.isPanelOpen = false;
          syncUI();
        };

        closeButton.addEventListener("click", closePanel);

        promptGenerate.addEventListener("click", async () => {
          const originalText = promptGenerate.textContent;
          const originalDisabled = promptGenerate.disabled;
          const originalOpacity = promptGenerate.style.opacity;

          promptGenerate.disabled = true;
          promptGenerate.textContent = "⏳ Génération en cours...";
          promptGenerate.style.opacity = "0.7";

          try {
            console.log("[Focals][MSG] Début génération via modale", replyState);
            await runSuggestReplyPipeline({
              button: promptGenerate,
              composer,
              conversationRoot,
              conversationName,
              editorIndex: index + 1,
              generationMode: replyState.selectedMode,
              customInstructions:
                replyState.selectedMode === "prompt_custom"
                  ? (replyState.promptReply || "").trim()
                  : null,
            });
          } finally {
            promptGenerate.disabled = originalDisabled;
            promptGenerate.textContent = originalText;
            promptGenerate.style.opacity = originalOpacity;
            closePanel();
          }
        });

        log("[MSG] BUTTON_BIND", {
          conversation: conversationName,
          composerId: composer.id || null,
          editorIndex: index + 1,
        });

        suggestButton.addEventListener("click", async () => {
          const originalText = suggestButton.textContent;
          const originalDisabled = suggestButton.disabled;
          const originalOpacity = suggestButton.style.opacity;

          suggestButton.disabled = true;
          suggestButton.textContent = "⏳ Génération...";
          suggestButton.style.opacity = "0.7";
          closePanel();
          log(
            `[MSG][UI] Button set to loading (conversation: "${conversationName}")`
          );

          try {
            await runSuggestReplyPipeline({
              button: suggestButton,
              composer,
              conversationRoot,
              conversationName,
              editorIndex: index + 1,
              generationMode: "auto",
            });
          } finally {
            suggestButton.disabled = originalDisabled;
            suggestButton.textContent = originalText;
            suggestButton.style.opacity = originalOpacity;
            log(
              `[MSG][UI] Button restored to idle (conversation: "${conversationName}")`
            );
          }
        });

        promptButton.addEventListener("click", () => {
          replyState.isPanelOpen = !replyState.isPanelOpen;
          console.log("[Focals][MSG] Ouverture modale relance", {
            isOpen: replyState.isPanelOpen,
            conversation: conversationName,
          });
          syncUI();
          if (replyState.isPanelOpen) {
            promptInput.focus();
          }
        });

        document.addEventListener("click", (event) => {
          const target = event.target;
          if (!replyState.isPanelOpen) return;
          if (popover.contains(target) || promptButton.contains(target)) return;
          closePanel();
        });

        popover.appendChild(closeButton);
        popover.appendChild(popoverTitle);
        popover.appendChild(popoverDescription);
        popover.appendChild(modesContainer);
        popover.appendChild(instructionsBlock);
        popover.appendChild(promptGenerate);

        buttonRow.appendChild(suggestButton);
        buttonRow.appendChild(promptButton);

        controlsWrapper.appendChild(buttonRow);
        controlsWrapper.appendChild(popover);

        rightActions.appendChild(controlsWrapper);

        syncUI();
        composer.dataset.focalsBound = "true";

        log("[MSG] Suggest and prompt reply buttons injected", {
          conversation: conversationName,
          editorIndex: index + 1,
        });
      });
    };

    const scheduleScan = () => {
      if (scanScheduled) return;
      scanScheduled = true;
      setTimeout(() => {
        scanScheduled = false;
        scanAndInject();
      }, 250);
    };

    const initMessagingWatcher = () => {
      scanAndInject();

      const startObserver = () => {
        const observer = new MutationObserver(() => {
          scheduleScan();
        });

        observer.observe(document.body, { childList: true, subtree: true });
      };

      if (document.body) {
        startObserver();
      } else {
        document.addEventListener("DOMContentLoaded", () => {
          scheduleScan();
          startObserver();
        });
      }

      setInterval(scheduleScan, 3000);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initMessagingWatcher);
    } else {
      initMessagingWatcher();
    }
  } catch (err) {
    error("[MSG] Fatal error in content-messaging.js", err);
  }
})();
