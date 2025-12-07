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
      systemPromptOverride: "focals_systemPromptOverride",
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
      system_prompt_override: "",
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

    const normalizeText = (text = "") => text.replace(/\s+/g, " ").trim();

    const getLastMessagesForBackend = (allMessages, limit = 3) => {
      if (!Array.isArray(allMessages)) return [];

      const sorted = [...allMessages].sort((a, b) => {
        const aDate = a.timestampRaw || a.timestamp;
        const bDate = b.timestampRaw || b.timestamp;

        if (aDate && bDate) {
          return new Date(aDate) - new Date(bDate);
        }

        return 0;
      });

      return sorted.slice(-limit);
    };

    const normalizeLinkedinUrl = (url) => {
      if (!url) return null;
      try {
        const prefixed = url.startsWith("http")
          ? url
          : url.startsWith("/")
            ? `https://www.linkedin.com${url}`
            : `https://www.linkedin.com/${url}`;
        const parsed = new URL(prefixed);
        const pathname = parsed.pathname.replace(/\/+$/, "");
        return `https://www.linkedin.com${pathname}/`;
      } catch (err) {
        warn("LINKEDIN_URL_NORMALIZE_ERROR", err?.message || err);
        return null;
      }
    };

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
      const firstIncomingWithName = messages.find(
        (m) => !m.fromMe && m.senderName
      );
      if (firstIncomingWithName?.senderName)
        return firstIncomingWithName.senderName;

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

    const resolveLinkedinProfileContext = async (
      rootElement = document,
      { candidateProfileUrl = null, freshProfile = null } = {}
    ) => {
      const pageProfile = extractCandidateProfileFromPage(rootElement);
      const targetUrl = candidateProfileUrl || pageProfile?.candidateProfileUrl || null;
      const normalizedTarget = normalizeLinkedinUrl(targetUrl);

      const cachedProfile = freshProfile || (await getLastScrapedProfile());
      const cachedProfileUrl = normalizeLinkedinUrl(
        cachedProfile?.linkedin_url ||
          cachedProfile?.url ||
          (cachedProfile?.profile_slug
            ? `https://www.linkedin.com/in/${cachedProfile.profile_slug}`
            : null)
      );

      const profileMatchesTarget = normalizedTarget
        ? cachedProfileUrl === normalizedTarget
        : !!cachedProfile;

      const usableProfile = profileMatchesTarget ? cachedProfile : null;

      const linkedinProfile = buildLinkedinProfileContext(
        usableProfile,
        targetUrl || null
      );

      return { linkedinProfile, cachedProfile: usableProfile, candidateProfileUrl: targetUrl };
    };

    const findConversationProfileLink = (conversationRoot = document) => {
      const headerSelectors = [
        ".msg-overlay-bubble-header",
        ".msg-thread__top-card",
        "header.msg-thread__top-card",
        ".msg-thread__link-to-profile",
      ];

      const anchorSelectors = [
        "a[href*='/in/']",
        ".msg-thread__link[href*='/in/']",
        ".msg-overlay-bubble-header__title a[href*='/in/']",
      ];

      let header = null;
      for (const selector of headerSelectors) {
        const node = conversationRoot.querySelector(selector);
        if (node) {
          header = node;
          break;
        }
      }

      const scopes = header ? [header] : [conversationRoot];

      for (const scope of scopes) {
        for (const selector of anchorSelectors) {
          const anchor = scope.querySelector(selector);
          if (!anchor) continue;
          const href = anchor.getAttribute("href") || "";
          if (!/\/in\//.test(href)) continue;
          if (anchor.closest("div.msg-s-event-listitem")) continue;

          const rawHref = href.split(/[?#]/)[0];
          const profileUrl = rawHref.startsWith("/in/")
            ? `https://www.linkedin.com${rawHref}`
            : rawHref;

          const nameNode =
            anchor.querySelector(".hoverable-link-text") || anchor.querySelector("span");
          const candidateName = normalizeText(
            nameNode?.textContent || anchor.textContent || ""
          );

          return { anchor, profileUrl, candidateName: candidateName || null };
        }
      }

      return null;
    };

    const openProfileTabInBackground = (profileUrl) =>
      new Promise((resolve, reject) => {
        try {
          chrome.runtime.sendMessage(
            { type: "FOCALS_SCRAPE_PROFILE_URL", url: profileUrl },
            (response) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              if (!response?.ok) {
                reject(new Error(response?.error || "Unable to open profile tab"));
                return;
              }
              resolve(response.tabId || null);
            }
          );
        } catch (err) {
          reject(err);
        }
      });

    const closeTabById = (tabId) =>
      new Promise((resolve) => {
        if (!tabId) return resolve(false);
        try {
          chrome.runtime.sendMessage({ type: "FOCALS_CLOSE_TAB", tabId }, () => resolve(true));
        } catch (err) {
          resolve(false);
        }
      });

    const waitForProfileScrape = async (profileUrl, { timeoutMs = 12000 } = {}) =>
      new Promise((resolve) => {
        const normalizedTarget = normalizeLinkedinUrl(profileUrl);
        if (!normalizedTarget) {
          resolve(null);
          return;
        }

        const matchesTarget = (profile) => {
          if (!profile) return false;
          const profileUrlCandidate = normalizeLinkedinUrl(
            profile.linkedin_url ||
              profile.url ||
              (profile.profile_slug ? `https://www.linkedin.com/in/${profile.profile_slug}` : null)
          );
          return profileUrlCandidate && profileUrlCandidate === normalizedTarget;
        };

        const cleanupAndResolve = (value) => {
          chrome.storage.onChanged.removeListener(onChange);
          clearTimeout(timeoutId);
          resolve(value);
        };

        const onChange = (changes, area) => {
          if (area !== "local") return;
          if (!changes?.[PROFILE_STORAGE_KEY]) return;
          const profile = changes[PROFILE_STORAGE_KEY].newValue;
          if (matchesTarget(profile)) {
            cleanupAndResolve(profile);
          }
        };

        chrome.storage.onChanged.addListener(onChange);

        const timeoutId = setTimeout(async () => {
          const latest = await getLastScrapedProfile();
          if (matchesTarget(latest)) {
            cleanupAndResolve(latest);
          } else {
            cleanupAndResolve(null);
          }
        }, timeoutMs);

      });

    const scrapeProfileFromLink = async (profileUrl) => {
      const normalizedTarget = normalizeLinkedinUrl(profileUrl);
      if (!normalizedTarget) {
        warn("PROFILE_LINK_INVALID", profileUrl);
        return null;
      }

      let tabId = null;
      try {
        tabId = await openProfileTabInBackground(normalizedTarget);
      } catch (err) {
        warn("PROFILE_TAB_OPEN_ERROR", err?.message || err);
      }

      const scrapedProfile = await waitForProfileScrape(normalizedTarget);

      if (tabId) {
        await closeTabById(tabId);
      }

      return scrapedProfile;
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
      const syncData = await getFromStorage("sync", {
        [STORAGE_KEYS.settings]: DEFAULT_SETTINGS,
        [STORAGE_KEYS.templates]: DEFAULT_TEMPLATES,
        [STORAGE_KEYS.activeTemplate]: DEFAULT_TEMPLATES[0].id,
        [STORAGE_KEYS.systemPromptOverride]: DEFAULT_SETTINGS.system_prompt_override,
      });

      const settings = { ...DEFAULT_SETTINGS, ...(syncData?.[STORAGE_KEYS.settings] || {}) };
      settings.system_prompt_override =
        syncData?.[STORAGE_KEYS.systemPromptOverride] || settings.system_prompt_override || "";

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

      return { settings, templates, activeTemplate };
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

        const senderName = normalizeText(
          container.querySelector(".msg-s-message-group__name")?.textContent || ""
        );

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

        if (senderName) {
          message.senderName = senderName;
        }

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

      return allMessages;
    };

    const generateReplyFromAPI = async (
      messages,
      { context = {}, systemPromptOverride = null } = {}
    ) => {
      if (!messages?.length) {
        warn("PIPELINE extract_messages: no messages found, aborting");
        return null;
      }

      const userId = await getOrCreateUserId();

      const lastMessages = getLastMessagesForBackend(messages, 3);

      const finalSystemPrompt =
        (context?.systemPromptOverride && context.systemPromptOverride.trim()) ||
        (systemPromptOverride && systemPromptOverride.trim()) ||
        null;

      const payload = {
        userId,
        messages: lastMessages.map((msg) => ({
          text: msg.text,
          fromMe: !!msg.fromMe,
          timestampRaw: msg.timestampRaw || msg.timestamp || new Date().toISOString(),
        })),
        context: {
          ...context,
          systemPromptOverride: finalSystemPrompt,
        },
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
      customInstructions,
      candidateProfileUrl = null,
      freshLinkedinProfile = null,
      candidateName: candidateNameOverride = null,
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

        const { settings } = await loadUserPreferences();
        const tone = settings?.tone || settings?.default_tone || "warm";
        const language =
          detectLanguageFromMessages(messages, settings.languageFallback || "fr") || "fr";
        const systemPromptOverride = (settings.system_prompt_override || "").trim();
        const profileResolution = await resolveLinkedinProfileContext(conversationRoot, {
          candidateProfileUrl,
          freshProfile: freshLinkedinProfile || null,
        });

        const candidateName =
          candidateNameOverride ||
          profileResolution.cachedProfile?.firstName ||
          profileResolution.cachedProfile?.name ||
          detectCandidateName(conversationName, messages);
        const trimmedCustomInstructions = (customInstructions || "").trim();
        const payloadContext = {
          language,
          tone,
          candidateName: candidateName || undefined,
          linkedinProfile: profileResolution.linkedinProfile || null,
          systemPromptOverride: trimmedCustomInstructions || null,
        };

        console.log("[Focals][MSG] generate payload context", payloadContext);

        const reply = await generateReplyFromAPI(messages, {
          context: payloadContext,
          systemPromptOverride,
        });
        console.log("[Focals][MSG] Réponse reçue", {
          hasReply: !!reply,
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
          primary: "#0b63f6",
          primaryHover: "#2f7dfc",
          primaryActive: "#5592ff",
          border: "#1b2945",
          text: "#e9edf5",
          muted: "#9fb1d3",
          surface: "#0b1220",
          elevated: "#0f1b32",
          overlay: "rgba(6, 12, 26, 0.65)",
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
          btn.style.padding = "10px 16px";
          btn.style.cursor = "pointer";
          btn.style.borderRadius = "999px";
          btn.style.border = "none";
          btn.style.background = palette.primary;
          btn.style.color = "#ffffff";
          btn.style.fontWeight = "700";
          btn.style.fontSize = "13px";
          btn.style.boxShadow = "0 6px 18px rgba(0,0,0,0.25)";
          btn.style.transition = "all 0.15s ease";
          btn.addEventListener("mouseenter", () => {
            btn.style.background = palette.primaryHover;
          });
          btn.addEventListener("mouseleave", () => {
            btn.style.background = uiState?.openMenu ? palette.primaryHover : palette.primary;
          });
          btn.addEventListener("mousedown", () => {
            btn.style.background = palette.primaryActive;
          });
          btn.addEventListener("mouseup", () => {
            btn.style.background = uiState?.openMenu ? palette.primaryHover : palette.primary;
          });
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
          menu.style.padding = "6px 0";
          menu.style.color = palette.text;
          menu.style.alignItems = "stretch";
          menu.style.boxShadow = "0 18px 40px rgba(0,0,0,0.35)";
          menu.style.zIndex = "2147483647";
          return menu;
        };

        const uiState = {
          openMenu: null,
          smartMode: "standard",
          customPrompt: "",
          showCustomModal: false,
        };

        const autoResize = (textarea, minHeight = 48) => {
          requestAnimationFrame(() => {
            textarea.style.height = `${minHeight}px`;
            const nextHeight = Math.max(minHeight, textarea.scrollHeight);
            textarea.style.height = `${nextHeight}px`;
          });
        };

        const customModal = document.createElement("div");
        customModal.style.position = "fixed";
        customModal.style.inset = "0";
        customModal.style.display = "none";
        customModal.style.alignItems = "center";
        customModal.style.justifyContent = "center";
        customModal.style.background = palette.overlay;
        customModal.style.zIndex = "2147483647";

        const customModalCard = document.createElement("div");
        customModalCard.style.background = palette.surface;
        customModalCard.style.border = `1px solid ${palette.border}`;
        customModalCard.style.borderRadius = "16px";
        customModalCard.style.padding = "18px";
        customModalCard.style.width = "480px";
        customModalCard.style.maxWidth = "calc(100% - 32px)";
        customModalCard.style.boxShadow = "0 24px 60px rgba(0,0,0,0.45)";
        customModalCard.style.color = palette.text;

        const customHeader = document.createElement("div");
        customHeader.style.display = "flex";
        customHeader.style.justifyContent = "space-between";
        customHeader.style.alignItems = "center";

        const customTitle = document.createElement("div");
        customTitle.textContent = "Create a custom reply";
        customTitle.style.fontWeight = "700";
        customTitle.style.fontSize = "15px";

        const customClose = document.createElement("button");
        customClose.textContent = "×";
        customClose.setAttribute("aria-label", "Close custom reply modal");
        customClose.style.background = "transparent";
        customClose.style.border = "none";
        customClose.style.color = palette.text;
        customClose.style.cursor = "pointer";
        customClose.style.fontSize = "18px";

        customHeader.appendChild(customTitle);
        customHeader.appendChild(customClose);

        const promptLabel = document.createElement("div");
        promptLabel.textContent = "Instructions pour la réponse";
        promptLabel.style.fontSize = "12px";
        promptLabel.style.color = palette.muted;
        promptLabel.style.marginTop = "12px";

        const promptInput = document.createElement("textarea");
        promptInput.placeholder =
          "Exemple : réponds en vouvoiement, fais une réponse courte qui remercie la personne et propose un call la semaine prochaine...";
        promptInput.style.width = "100%";
        promptInput.style.minHeight = "140px";
        promptInput.style.maxHeight = "260px";
        promptInput.style.background = "rgba(255,255,255,0.03)";
        promptInput.style.color = palette.text;
        promptInput.style.border = `1px solid ${palette.border}`;
        promptInput.style.borderRadius = "10px";
        promptInput.style.padding = "10px";
        promptInput.style.resize = "vertical";
        promptInput.style.overflowY = "auto";

        const customGenerate = document.createElement("button");
        customGenerate.textContent = "Générer la réponse";
        customGenerate.className = "artdeco-button";
        customGenerate.style.marginTop = "16px";
        customGenerate.style.width = "100%";
        customGenerate.style.padding = "12px";
        customGenerate.style.borderRadius = "999px";
        customGenerate.style.background = palette.primary;
        customGenerate.style.border = `1px solid ${palette.border}`;
        customGenerate.style.color = "#ffffff";
        customGenerate.style.cursor = "pointer";
        customGenerate.style.fontWeight = "700";

        customModalCard.appendChild(customHeader);
        customModalCard.appendChild(promptLabel);
        customModalCard.appendChild(promptInput);
        customModalCard.appendChild(customGenerate);
        customModal.appendChild(customModalCard);

        const closeCustomModal = () => {
          uiState.showCustomModal = false;
          syncUI();
        };

        const openCustomModal = () => {
          uiState.showCustomModal = true;
          uiState.openMenu = null;
          syncUI();
          setTimeout(() => promptInput.focus(), 50);
        };

        customModal.addEventListener("click", (event) => {
          if (event.target === customModal) {
            closeCustomModal();
          }
        });
        customClose.addEventListener("click", closeCustomModal);

const smartButton = createMainButton("Smart Reply ▾");
        const smartMenu = createMenuContainer();

        const menuOption = (label, action) => {
          const option = document.createElement("button");
          option.style.background = "transparent";
          option.style.border = "none";
          option.style.textAlign = "left";
          option.style.padding = "12px 16px";
          option.style.cursor = "pointer";
          option.style.color = palette.text;
          option.style.fontWeight = "600";
          option.style.fontSize = "13px";
          option.style.width = "100%";

          option.addEventListener("mouseenter", () => {
            option.style.background = "rgba(255,255,255,0.08)";
          });
          option.addEventListener("mouseleave", () => {
            option.style.background = "transparent";
          });

          option.addEventListener("click", async () => {
            uiState.openMenu = null;
            syncUI();
            await action();
          });

          option.textContent = label;
          return option;
        };

        const handleStandardReply = async () => {
          smartButton.textContent = "⏳ Smart Reply…";
          smartButton.disabled = true;
          smartButton.style.opacity = "0.7";
          try {
            await runSuggestReplyPipeline({
              button: smartButton,
              composer,
              conversationRoot,
              conversationName,
              editorIndex: index + 1,
            });
          } finally {
            smartButton.textContent = "Smart Reply ▾";
            smartButton.disabled = false;
            smartButton.style.opacity = "1";
          }
        };

        const syncMenuOptions = () => {
          smartMenu.innerHTML = "";
          [
            { label: "Standard reply", action: handleStandardReply },
            { label: "Custom reply", action: openCustomModal },
          ].forEach(({ label, action }) => smartMenu.appendChild(menuOption(label, action)));
        };

        const syncUI = () => {
          smartMenu.style.display = uiState.openMenu ? "flex" : "none";

          smartButton.textContent = uiState.openMenu ? "Smart Reply ▴" : "Smart Reply ▾";
          smartButton.style.background = uiState.openMenu ? palette.primaryHover : palette.primary;

          customModal.style.display = uiState.showCustomModal ? "flex" : "none";
          const hasPrompt = (uiState.customPrompt || "").trim().length > 0;
          customGenerate.disabled = !hasPrompt;
          customGenerate.style.opacity = customGenerate.disabled ? "0.6" : "1";
        };

        smartButton.addEventListener("click", () => {
          uiState.openMenu = uiState.openMenu ? null : "menu";
          syncUI();
        });

        document.addEventListener("click", (event) => {
          const target = event.target;
          if (
            smartMenu.contains(target) ||
            smartButton.contains(target) ||
            customModal.contains(target)
          ) {
            return;
          }
          if (uiState.openMenu) {
            uiState.openMenu = null;
            syncUI();
          }
        });

        promptInput.addEventListener("input", () => {
          uiState.customPrompt = promptInput.value;
          autoResize(promptInput, 120);
          syncUI();
        });

        autoResize(promptInput, 120);

        const buildCustomInstructions = () => (uiState.customPrompt || "").trim();

        customGenerate.addEventListener("click", async () => {
          const instructions = buildCustomInstructions();
          if (!instructions.trim()) {
            alert("Ajoutez des instructions avant de générer la réponse.");
            return;
          }
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
              customInstructions: instructions,
            });
            closeCustomModal();
          } finally {
            customGenerate.textContent = "Générer la réponse";
            customGenerate.disabled = false;
            customGenerate.style.opacity = "1";
          }
        });

        syncMenuOptions();
        syncUI();

        const smartWrapper = document.createElement("div");
        smartWrapper.style.position = "relative";
        smartWrapper.appendChild(smartButton);
        smartWrapper.appendChild(smartMenu);

        dropdownsRow.appendChild(smartWrapper);

        controlsWrapper.appendChild(dropdownsRow);
        rightActions.appendChild(controlsWrapper);

        document.body.appendChild(customModal);

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
