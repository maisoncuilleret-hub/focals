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

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

    const readFileAsText = (file) =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(event.target?.result || "");
        reader.onerror = () => reject(reader.error || new Error("File read error"));
        reader.readAsText(file);
      });

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

    const getLastScrapedProfile = () =>
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
      const cachedProfile = await getLastScrapedProfile();
      const linkedinProfile = buildLinkedinProfileContext(
        cachedProfile,
        pageProfile?.candidateProfileUrl || null
      );

      return { linkedinProfile, cachedProfile, candidateProfileUrl: pageProfile?.candidateProfileUrl };
    };

    const forceProfileRescrape = () =>
      new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: "FOCALS_FORCE_RESCRAPE" }, () => resolve(true));
        } catch (err) {
          warn("PROFILE_FORCE_RESCRAPE_ERROR", err?.message || err);
          resolve(false);
        }
      });

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
        if (generationMode === "followup_personalized") {
          await forceProfileRescrape();
          await wait(400);
        }
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

          const linkedinProfileCandidate = profileResolution.cachedProfile || null;
          const hasValidProfile = !!(
            linkedinProfileCandidate &&
            (
              (Array.isArray(linkedinProfileCandidate.experiences) &&
                linkedinProfileCandidate.experiences.length > 0) ||
              linkedinProfileCandidate.current_title ||
              linkedinProfileCandidate.current_company ||
              linkedinProfileCandidate.headline
            )
          );

          payloadContext = {
            ...baseContext,
          };
          if (jobContext) {
            payloadContext.job = jobContext;
          }

          if (hasValidProfile) {
            if (!linkedinProfileCandidate.linkedin_url && profileResolution.candidateProfileUrl) {
              linkedinProfileCandidate.linkedin_url = profileResolution.candidateProfileUrl;
            }
            payloadContext.linkedinProfile = linkedinProfileCandidate;
            console.log("[Focals][MSG] Attaching linkedinProfile to context", {
              url: linkedinProfileCandidate.linkedin_url,
              name: linkedinProfileCandidate.name,
              currentTitle: linkedinProfileCandidate.current_title,
              currentCompany: linkedinProfileCandidate.current_company,
              experiencesCount: linkedinProfileCandidate.experiences?.length || 0,
            });
          } else {
            console.warn(
              "[Focals][MSG] No usable linkedinProfile found, personalized mode will fall back to classic follow-up"
            );
          }
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

        const palette = {
          primary: "#15294b",
          primaryHover: "#1f3a6b",
          border: "#1f2a44",
          text: "#e5e7eb",
          muted: "#9ca3af",
          surface: "#0b1220",
        };

        const controlsWrapper = document.createElement("div");
        controlsWrapper.style.position = "relative";
        controlsWrapper.style.display = "flex";
        controlsWrapper.style.flexDirection = "column";
        controlsWrapper.style.alignItems = "flex-end";
        controlsWrapper.style.flex = "1";

        const dropdownsRow = document.createElement("div");
        dropdownsRow.className = BUTTON_CLASS;
        dropdownsRow.style.display = "flex";
        dropdownsRow.style.gap = "8px";
        dropdownsRow.style.marginLeft = "8px";
        dropdownsRow.style.alignItems = "center";

        const createMainButton = (label) => {
          const btn = document.createElement("button");
          btn.textContent = label;
          btn.style.padding = "8px 14px";
          btn.style.cursor = "pointer";
          btn.style.borderRadius = "999px";
          btn.style.border = `1px solid ${palette.border}`;
          btn.style.background = palette.primary;
          btn.style.color = palette.text;
          btn.style.fontWeight = "700";
          btn.style.fontSize = "13px";
          btn.style.boxShadow = "0 6px 18px rgba(0,0,0,0.25)";
          btn.style.transition = "all 0.2s ease";
          return btn;
        };

        const createMenuContainer = () => {
          const menu = document.createElement("div");
          menu.style.display = "none";
          menu.style.flexDirection = "column";
          menu.style.position = "absolute";
          menu.style.bottom = "44px";
          menu.style.right = "0";
          menu.style.background = palette.surface;
          menu.style.border = `1px solid ${palette.border}`;
          menu.style.borderRadius = "12px";
          menu.style.minWidth = "240px";
          menu.style.padding = "8px";
          menu.style.boxShadow = "0 18px 40px rgba(0,0,0,0.35)";
          menu.style.zIndex = "2147483647";
          return menu;
        };

        const uiState = {
          openMenu: null,
          conversationMode: "conversation_standard",
          relanceMode: "followup_standard",
          showCustomCard: false,
          customUploadText: "",
          customPasteText: "",
          customPrompt: "",
          uploadFilename: "",
        };

        const customCard = document.createElement("div");
        customCard.style.display = "none";
        customCard.style.background = palette.surface;
        customCard.style.border = `1px solid ${palette.border}`;
        customCard.style.borderRadius = "14px";
        customCard.style.padding = "14px";
        customCard.style.margin = "8px 0";
        customCard.style.color = palette.text;
        customCard.style.boxShadow = "0 14px 30px rgba(0,0,0,0.35)";
        customCard.style.position = "relative";

        const customCardHeader = document.createElement("div");
        customCardHeader.style.display = "flex";
        customCardHeader.style.justifyContent = "space-between";
        customCardHeader.style.alignItems = "center";

        const customTitle = document.createElement("div");
        customTitle.textContent = "Conversation personnalisée";
        customTitle.style.fontWeight = "700";
        customTitle.style.fontSize = "14px";

        const customClose = document.createElement("button");
        customClose.textContent = "×";
        customClose.setAttribute("aria-label", "Fermer la carte personnalisée");
        customClose.style.background = "transparent";
        customClose.style.border = "none";
        customClose.style.color = palette.text;
        customClose.style.cursor = "pointer";
        customClose.style.fontSize = "16px";

        customCardHeader.appendChild(customTitle);
        customCardHeader.appendChild(customClose);

        const uploadArea = document.createElement("label");
        uploadArea.textContent = "Glissez un fichier ou cliquez pour importer";
        uploadArea.style.display = "block";
        uploadArea.style.border = `1px dashed ${palette.border}`;
        uploadArea.style.borderRadius = "12px";
        uploadArea.style.padding = "12px";
        uploadArea.style.marginTop = "10px";
        uploadArea.style.cursor = "pointer";
        uploadArea.style.background = "rgba(255,255,255,0.03)";
        uploadArea.style.color = palette.muted;
        uploadArea.style.textAlign = "center";

        const uploadInput = document.createElement("input");
        uploadInput.type = "file";
        uploadInput.style.display = "none";

        const uploadMeta = document.createElement("div");
        uploadMeta.style.fontSize = "12px";
        uploadMeta.style.color = palette.muted;
        uploadMeta.style.marginTop = "6px";

        uploadArea.appendChild(uploadInput);

        const pasteLabel = document.createElement("div");
        pasteLabel.textContent = "Ou collez du contenu ici...";
        pasteLabel.style.fontSize = "12px";
        pasteLabel.style.color = palette.muted;
        pasteLabel.style.marginTop = "12px";

        const pasteArea = document.createElement("textarea");
        pasteArea.style.width = "100%";
        pasteArea.style.minHeight = "80px";
        pasteArea.style.background = "rgba(255,255,255,0.03)";
        pasteArea.style.color = palette.text;
        pasteArea.style.border = `1px solid ${palette.border}`;
        pasteArea.style.borderRadius = "10px";
        pasteArea.style.padding = "10px";
        pasteArea.style.resize = "vertical";

        const promptLabel = document.createElement("div");
        promptLabel.textContent = "Instruction pour l’agent (ex: rédige un feedback structuré)";
        promptLabel.style.fontSize = "12px";
        promptLabel.style.color = palette.muted;
        promptLabel.style.marginTop = "12px";

        const promptInput = document.createElement("textarea");
        promptInput.placeholder = "Décris le ton, le format ou les attentes…";
        promptInput.style.width = "100%";
        promptInput.style.minHeight = "72px";
        promptInput.style.background = "rgba(255,255,255,0.03)";
        promptInput.style.color = palette.text;
        promptInput.style.border = `1px solid ${palette.border}`;
        promptInput.style.borderRadius = "10px";
        promptInput.style.padding = "10px";
        promptInput.style.resize = "vertical";

        const customGenerate = document.createElement("button");
        customGenerate.textContent = "Générer la réponse";
        customGenerate.className = "artdeco-button";
        customGenerate.style.marginTop = "14px";
        customGenerate.style.width = "100%";
        customGenerate.style.padding = "10px";
        customGenerate.style.borderRadius = "999px";
        customGenerate.style.background = palette.primary;
        customGenerate.style.border = `1px solid ${palette.border}`;
        customGenerate.style.color = palette.text;
        customGenerate.style.cursor = "pointer";
        customGenerate.style.fontWeight = "700";

        customCard.appendChild(customCardHeader);
        customCard.appendChild(uploadArea);
        customCard.appendChild(uploadMeta);
        customCard.appendChild(pasteLabel);
        customCard.appendChild(pasteArea);
        customCard.appendChild(promptLabel);
        customCard.appendChild(promptInput);
        customCard.appendChild(customGenerate);

        const conversationButton = createMainButton("Conversation ▾");
        const relanceButton = createMainButton("Relance ▾");

        const conversationMenu = createMenuContainer();
        const relanceMenu = createMenuContainer();

        const menuOption = (label, description, value, group) => {
          const option = document.createElement("button");
          option.style.background = "transparent";
          option.style.border = "none";
          option.style.textAlign = "left";
          option.style.padding = "10px";
          option.style.borderRadius = "10px";
          option.style.cursor = "pointer";
          option.style.color = palette.text;
          option.innerHTML = `<div style="font-weight:700; font-size:13px;">${label}</div><div style="font-size:12px; color:${palette.muted};">${description}</div>`;

          option.addEventListener("mouseenter", () => {
            option.style.background = "rgba(255,255,255,0.05)";
          });
          option.addEventListener("mouseleave", () => {
            option.style.background = "transparent";
          });

          option.addEventListener("click", async () => {
            uiState[`${group}Mode`] = value;
            uiState.openMenu = null;
            if (group === "conversation") {
              if (value === "conversation_standard") {
                uiState.showCustomCard = false;
                await handleConversationStandard();
              } else {
                uiState.showCustomCard = true;
                pasteArea.focus();
              }
            } else if (group === "relance") {
              if (value === "followup_standard") {
                uiState.showCustomCard = false;
                await handleFollowupStandard();
              } else {
                await handleFollowupPersonalized();
              }
            }
            syncUI();
          });

          return option;
        };

        const handleConversationStandard = async () => {
          const originalText = conversationButton.textContent;
          conversationButton.textContent = "⏳ Conversation…";
          conversationButton.disabled = true;
          conversationButton.style.opacity = "0.7";
          try {
            await runSuggestReplyPipeline({
              button: conversationButton,
              composer,
              conversationRoot,
              conversationName,
              editorIndex: index + 1,
              generationMode: "auto",
            });
          } finally {
            conversationButton.textContent = originalText;
            conversationButton.disabled = false;
            conversationButton.style.opacity = "1";
          }
        };

        const handleFollowupStandard = async () => {
          const originalText = relanceButton.textContent;
          relanceButton.textContent = "⏳ Relance…";
          relanceButton.disabled = true;
          relanceButton.style.opacity = "0.7";
          try {
            await runSuggestReplyPipeline({
              button: relanceButton,
              composer,
              conversationRoot,
              conversationName,
              editorIndex: index + 1,
              generationMode: "followup_classic",
            });
          } finally {
            relanceButton.textContent = originalText;
            relanceButton.disabled = false;
            relanceButton.style.opacity = "1";
          }
        };

        const triggerAssociationModal = () => {
          try {
            chrome.runtime.sendMessage({ type: "FOCALS_OPEN_PROFILE_ASSOCIATION_MODAL" });
          } catch (err) {
            warn("ASSOCIATION_MODAL_ERROR", err?.message || err);
          }
          alert("Associe un profil LinkedIn via la modale Focals pour continuer la relance personnalisée.");
        };

        const handleFollowupPersonalized = async () => {
          const profileContext = await resolveLinkedinProfileContext(conversationRoot);
          const hasValidProfile = !!(
            profileContext.cachedProfile &&
            ((Array.isArray(profileContext.cachedProfile.experiences) &&
              profileContext.cachedProfile.experiences.length > 0) ||
              profileContext.cachedProfile.current_title ||
              profileContext.cachedProfile.current_company ||
              profileContext.cachedProfile.headline)
          );

          if (!hasValidProfile) {
            triggerAssociationModal();
            return;
          }

          const originalText = relanceButton.textContent;
          relanceButton.textContent = "⏳ Relance…";
          relanceButton.disabled = true;
          relanceButton.style.opacity = "0.7";
          try {
            await runSuggestReplyPipeline({
              button: relanceButton,
              composer,
              conversationRoot,
              conversationName,
              editorIndex: index + 1,
              generationMode: "followup_personalized",
            });
          } finally {
            relanceButton.textContent = originalText;
            relanceButton.disabled = false;
            relanceButton.style.opacity = "1";
          }
        };

        const syncMenuOptions = () => {
          conversationMenu.innerHTML = "";
          conversationMenu.append(
            menuOption(
              "Standard",
              "Génère une réponse contextuelle à partir du thread.",
              "conversation_standard",
              "conversation"
            ),
            menuOption(
              "Personnalisé",
              "Ajoute un fichier, du texte ou un prompt pour guider la réponse.",
              "conversation_custom",
              "conversation"
            )
          );

          relanceMenu.innerHTML = "";
          relanceMenu.append(
            menuOption(
              "Relance standard",
              "Relance courte basée sur le thread et le prénom.",
              "followup_standard",
              "relance"
            ),
            menuOption(
              "Relance personnalisée",
              "Utilise le profil associé Focals pour une relance sur-mesure.",
              "followup_personalized",
              "relance"
            )
          );
        };

        const syncUI = () => {
          conversationMenu.style.display =
            uiState.openMenu === "conversation" ? "flex" : "none";
          relanceMenu.style.display = uiState.openMenu === "relance" ? "flex" : "none";

          conversationButton.textContent =
            uiState.openMenu === "conversation" ? "Conversation ▴" : "Conversation ▾";
          relanceButton.textContent =
            uiState.openMenu === "relance" ? "Relance ▴" : "Relance ▾";

          conversationButton.style.background =
            uiState.openMenu === "conversation" ? palette.primaryHover : palette.primary;
          relanceButton.style.background =
            uiState.openMenu === "relance" ? palette.primaryHover : palette.primary;

          customCard.style.display = uiState.showCustomCard ? "block" : "none";

          const uploadInfo = [];
          if (uiState.uploadFilename) uploadInfo.push(`Fichier: ${uiState.uploadFilename}`);
          if (uiState.customUploadText) uploadInfo.push("Contenu du fichier chargé");
          uploadMeta.textContent = uploadInfo.join(" – ");

          const hasContent =
            (uiState.customUploadText || "").trim().length > 0 ||
            (uiState.customPasteText || "").trim().length > 0;
          const hasPrompt = (uiState.customPrompt || "").trim().length > 0;
          customGenerate.disabled = !hasContent && !hasPrompt;
          customGenerate.style.opacity = customGenerate.disabled ? "0.6" : "1";
        };

        conversationButton.addEventListener("click", () => {
          uiState.openMenu = uiState.openMenu === "conversation" ? null : "conversation";
          uiState.showCustomCard = uiState.showCustomCard && uiState.openMenu === "conversation";
          syncUI();
        });

        relanceButton.addEventListener("click", () => {
          uiState.openMenu = uiState.openMenu === "relance" ? null : "relance";
          syncUI();
        });

        document.addEventListener("click", (event) => {
          const target = event.target;
          if (
            conversationMenu.contains(target) ||
            relanceMenu.contains(target) ||
            conversationButton.contains(target) ||
            relanceButton.contains(target) ||
            customCard.contains(target)
          ) {
            return;
          }
          if (uiState.openMenu || uiState.showCustomCard) {
            uiState.openMenu = null;
            syncUI();
          }
        });

        uploadArea.addEventListener("dragover", (event) => {
          event.preventDefault();
          uploadArea.style.background = "rgba(255,255,255,0.06)";
        });
        uploadArea.addEventListener("dragleave", () => {
          uploadArea.style.background = "rgba(255,255,255,0.03)";
        });
        uploadArea.addEventListener("drop", async (event) => {
          event.preventDefault();
          const file = event.dataTransfer?.files?.[0];
          if (!file) return;
          uiState.uploadFilename = file.name;
          uiState.customUploadText = await readFileAsText(file);
          uploadArea.style.background = "rgba(255,255,255,0.03)";
          syncUI();
        });

        uploadArea.addEventListener("click", () => uploadInput.click());
        uploadInput.addEventListener("change", async (event) => {
          const file = event.target?.files?.[0];
          if (!file) return;
          uiState.uploadFilename = file.name;
          uiState.customUploadText = await readFileAsText(file);
          syncUI();
        });

        pasteArea.addEventListener("input", () => {
          uiState.customPasteText = pasteArea.value;
          syncUI();
        });

        promptInput.addEventListener("input", () => {
          uiState.customPrompt = promptInput.value;
          syncUI();
        });

        customClose.addEventListener("click", () => {
          uiState.showCustomCard = false;
          syncUI();
        });

        const buildCustomInstructions = () => {
          const segments = [];
          if ((uiState.customUploadText || "").trim()) {
            segments.push(`Contenu importé:\n${uiState.customUploadText.trim()}`);
          }
          if ((uiState.customPasteText || "").trim()) {
            segments.push(`Contenu collé:\n${uiState.customPasteText.trim()}`);
          }
          if ((uiState.customPrompt || "").trim()) {
            segments.push(`Instruction: ${uiState.customPrompt.trim()}`);
          }
          return segments.join("\n\n");
        };

        customGenerate.addEventListener("click", async () => {
          const instructions = buildCustomInstructions();
          const originalText = customGenerate.textContent;
          customGenerate.textContent = "⏳ Génération…";
          customGenerate.disabled = true;
          customGenerate.style.opacity = "0.7";
          try {
            await runSuggestReplyPipeline({
              button: customGenerate,
              composer,
              conversationRoot,
              conversationName,
              editorIndex: index + 1,
              generationMode: "prompt_custom",
              customInstructions: instructions,
            });
          } finally {
            customGenerate.textContent = originalText;
            customGenerate.disabled = false;
            customGenerate.style.opacity = "1";
          }
        });

        syncMenuOptions();
        syncUI();

        const conversationWrapper = document.createElement("div");
        conversationWrapper.style.position = "relative";
        conversationWrapper.appendChild(conversationButton);
        conversationWrapper.appendChild(conversationMenu);

        const relanceWrapper = document.createElement("div");
        relanceWrapper.style.position = "relative";
        relanceWrapper.appendChild(relanceButton);
        relanceWrapper.appendChild(relanceMenu);

        dropdownsRow.appendChild(conversationWrapper);
        dropdownsRow.appendChild(relanceWrapper);

        controlsWrapper.appendChild(dropdownsRow);
        composer.insertBefore(customCard, footer);
        rightActions.appendChild(controlsWrapper);

        composer.dataset.focalsBound = "true";

        log("[MSG] Conversational controls injected", {
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
