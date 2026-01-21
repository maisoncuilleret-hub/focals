console.log('[FOCALS DEBUG] messaging content script loaded – v3');
console.log(
  '[FOCALS DEBUG] messaging content script context:',
  'href=',
  window.location.href,
  'isTop=',
  window.top === window,
  'frameElement=',
  window.frameElement
);

(() => {
  const FOCALS_DEBUG = (() => {
    try {
      return localStorage.getItem("FOCALS_DEBUG_MSG") === "true";
    } catch (err) {
      console.warn("[Focals][MSG][DEBUG] Unable to read debug flag", err);
      return false;
    }
  })();

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

  function getLinkedinMessagingRoot() {
    // Sur certaines sessions, LinkedIn met la messagerie dans un Shadow DOM
    const outlet = document.getElementById("interop-outlet");
    if (outlet && outlet.shadowRoot) {
      console.log("[FOCALS][SHADOW] using interop-outlet.shadowRoot as messaging root");
      return outlet.shadowRoot;
    }

    // Fallback : comportement classique (pas de Shadow DOM)
    return document;
  }

  function sendApiRequest({ endpoint, method = "GET", body, params }) {
    return new Promise((resolve, reject) => {
      const payload = { type: "API_REQUEST", endpoint, method, body, params };

      const sendWithRetry = (attempt = 1) => {
        console.log(
          `[Focals][MSG][API_REQUEST] attempt ${attempt} -> ${method} ${endpoint}`
        );
        chrome.runtime.sendMessage(payload, (response) => {
          if (chrome.runtime.lastError) {
            const message = chrome.runtime.lastError.message || "Runtime messaging failed";

            const transient =
              /Extension context invalidated/i.test(message) ||
              /Receiving end does not exist/i.test(message);

            console.warn(
              `[Focals][MSG][API_REQUEST] lastError on attempt ${attempt}: ${message}`
            );

            // The background service worker can be torn down between attempts, which triggers
            // "Extension context invalidated." or a missing receiver. Retry a few times to let
            // Chrome revive the context.
            if (attempt < 3 && transient) {
              setTimeout(() => sendWithRetry(attempt + 1), attempt * 100);
              return;
            }

            reject(new Error(message));
            return;
          }

          if (!response) {
            console.warn(
              `[Focals][MSG][API_REQUEST] empty response on attempt ${attempt}, retrying if possible`
            );
            if (attempt < 3) {
              setTimeout(() => sendWithRetry(attempt + 1), attempt * 100);
              return;
            }
            reject(new Error("Empty response from background"));
            return;
          }

          if (!response?.ok) {
            reject(new Error(response?.error || "API request failed"));
            return;
          }

          resolve(response.data);
        });
      };

      sendWithRetry();
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

    const hashText = (text = "") => {
      let hash = 0;
      for (let i = 0; i < text.length; i++) {
        hash = (hash << 5) - hash + text.charCodeAt(i);
        hash |= 0;
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    };

    const containsEmailLike = (text = "") => /@[\w.-]+\.[A-Za-z]{2,}/.test(text);

    const cleanMessageText = (text = "") => {
      if (!text) return "";
      return text
        .replace(/\r/g, "")
        .replace(/\u00a0/g, " ")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    };

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
      const delimiters = ["|", "·", "•", "-", " avec ", " with "];
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
          description: exp.description || null,
          descriptionBullets: exp.descriptionBullets || null,
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

    const resolveConversationId = (rootElement) => {
      if (!rootElement) return null;

      const attributeCandidates = [
        "data-conversation-id",
        "data-convo-id",
        "data-entity-urn",
      ];

      for (const attr of attributeCandidates) {
        const value = rootElement.getAttribute?.(attr);
        if (value) return value;
      }

      const nodeWithId = rootElement.querySelector?.(
        "[data-conversation-id],[data-convo-id],[data-entity-urn]"
      );
      if (nodeWithId) {
        for (const attr of attributeCandidates) {
          const value = nodeWithId.getAttribute?.(attr);
          if (value) return value;
        }
      }

      return null;
    };

    const extractLinkedInMessages = (rootElement = document) => {
      const usingDocument = rootElement === document;
      const candidateRoots = [rootElement];

      if (usingDocument) {
        const shadowRoot = getLinkedinMessagingRoot();
        if (shadowRoot && shadowRoot !== document) {
          candidateRoots.push(shadowRoot);
        }
      }

      const allMessages = [];
      let inspectedSelector =
        'div.msg-s-event-listitem[data-view-name="message-list-item"]';

      for (const scope of candidateRoots) {
        const scopeLabel = scope === document ? "document" : "shadow-root";
        const messageNodes = Array.from(scope.querySelectorAll(inspectedSelector));

        log(`[SCRAPE] Using ${scopeLabel} for messages, found ${messageNodes.length}`);

        if (!messageNodes.length) continue;

        messageNodes.forEach((container, index) => {
          const body = container.querySelector("p.msg-s-event-listitem__body");

          const seeMoreButton = body?.querySelector(
            'button.msg-s-event-listitem__show-more-text, button[aria-label*="See more" i], button[aria-label*="Voir plus" i]'
          );
          if (seeMoreButton && !seeMoreButton.dataset?.focalsExpanded) {
            try {
              seeMoreButton.dataset.focalsExpanded = "1";
              seeMoreButton.click();
              log("[SCRAPE] Clicked See more on message", index);
            } catch (err) {
              warn("[SCRAPE] Unable to expand See more", err?.message || err);
            }
          }

          const rawInnerText = (body?.innerText || "").trim();
          const rawTextContent = (body?.textContent || "").trim();
          const prefersTextContent = rawTextContent.length >= rawInnerText.length;
          let text = cleanMessageText(
            prefersTextContent ? rawTextContent : rawInnerText
          );

          const rawMaxLength = Math.max(rawInnerText.length, rawTextContent.length);
          const rawHasEmail = containsEmailLike(rawInnerText) || containsEmailLike(rawTextContent);
          const rawHash = hashText(
            rawTextContent.length >= rawInnerText.length ? rawTextContent : rawInnerText
          );

          if (text.length < rawTextContent.length * 0.6) {
            text = cleanMessageText(rawTextContent || rawInnerText);
            log("[SCRAPE] Fallback to textContent due to short text length");
          }

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
            __debug: {
              rawLength: rawMaxLength,
              rawHash,
              rawHadEmail: rawHasEmail,
              source: prefersTextContent ? "textContent" : "innerText",
            },
          };

          if (senderName) {
            message.senderName = senderName;
          }

          log("[SCRAPE] Built message object:", {
            fromMe,
            length: text.length,
            timestampRaw,
            source: message.__debug.source,
            hash: hashText(text),
          });

          if (message.__debug.rawHadEmail && !containsEmailLike(text)) {
            warn("[SCRAPE] possible truncation: raw text hinted email but extracted text does not", {
              extractedLength: text.length,
              rawLength: rawMaxLength,
            });
          }

          allMessages.push(message);
        });

        break;
      }

      if (!allMessages.length) {
        warn("[SCRAPE] No messages found after parsing");
        return [];
      }

      const lastInbound = [...allMessages].reverse().find((m) => !m.fromMe) || null;
      if (lastInbound) {
        debugLog("LAST_INBOUND", {
          length: lastInbound.text?.length || 0,
          hash: hashText(lastInbound.text || ""),
          rawLength: lastInbound.__debug?.rawLength || null,
          rawHash: lastInbound.__debug?.rawHash || null,
        });
      }

      return allMessages;
    };

    const generateReplyFromAPI = async (
      messages,
      { context = {}, systemPromptOverride = null, conversationName = null, conversationRoot = null } = {}
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

      const conversationId = resolveConversationId(conversationRoot);
      const lastInbound = [...messages].reverse().find((m) => !m.fromMe) || null;

      debugLog("PAYLOAD_DIAGNOSTICS", {
        conversationId: conversationId || null,
        conversationName: conversationName || null,
        messageCount: messages.length,
        lastInbound: lastInbound
          ? {
              length: lastInbound.text?.length || 0,
              hash: hashText(lastInbound.text || ""),
              rawLength: lastInbound.__debug?.rawLength || null,
            }
          : null,
        payloadMessages: payload.messages.map((m) => ({
          length: m.text?.length || 0,
          hash: hashText(m.text || ""),
          fromMe: m.fromMe,
        })),
      });

      if (lastInbound?.__debug?.rawHadEmail && !containsEmailLike(lastInbound.text)) {
        warn("[PAYLOAD] possible truncation: inbound message lost email-like pattern", {
          payloadLength: lastInbound.text?.length || 0,
          rawLength: lastInbound.__debug.rawLength,
        });
      }

      log("PIPELINE api_call: prepared payload", {
        conversationId: conversationId || "n/a",
        messageCount: payload.messages.length,
        payloadLengths: payload.messages.map((m) => m.text?.length || 0),
      });

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
        const reason = err?.message || "network failure";
        alert(`Erreur Focals : ${reason}`);
        return null;
      }
    };

    const backendGeneratePersonalizedFollowup = async ({
      profileUrl,
      threadText,
    }) => {
      if (!profileUrl) {
        warn("[FOLLOWUP] Missing profile URL for personalized follow-up");
        return null;
      }

      try {
        const userId = await getOrCreateUserId();
        const payload = {
          userId,
          mode: "personalized_followup",
          profileUrl,
          threadText,
        };

        const data = await sendApiRequest({
          endpoint: FOCALS_GENERATE_REPLY_ENDPOINT,
          method: "POST",
          body: payload,
        });

        const replyText = data?.replyText || data?.reply?.text || null;
        if (!replyText) {
          warn("[FOLLOWUP] backendGeneratePersonalizedFollowup empty reply");
        }

        return replyText;
      } catch (err) {
        error("[FOLLOWUP] backendGeneratePersonalizedFollowup failed", err);
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
          conversationName,
          conversationRoot,
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

    const renderSmartReplyMenu = (shadowRoot, options = {}) => {
      const style = document.createElement("style");
      style.textContent = `
        :host {
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          position: relative;
          display: inline-flex;
          align-items: center;
        }
        .focals-wrapper {
          position: relative;
          display: inline-flex;
          align-items: center;
        }
        .focals-trigger {
          border: none;
          border-radius: 16px;
          background: #0b63f6;
          color: #fff;
          padding: 8px 12px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .focals-trigger.is-loading {
          cursor: wait;
          opacity: 0.9;
        }
        .focals-trigger:disabled {
          opacity: 0.8;
          cursor: not-allowed;
        }
        .focals-trigger .focals-loader {
          display: none;
        }
        .focals-trigger.is-loading .focals-loader {
          display: inline-block;
        }
        .focals-trigger.is-loading .focals-caret {
          display: none;
        }
        .focals-trigger:hover {
          background: #2f7dfc;
        }
        .focals-menu {
          position: absolute;
          right: 0;
          top: auto;
          bottom: calc(100% + 6px);
          display: none;
          flex-direction: column;
          min-width: 220px;
          background: #0f1b32;
          border: 1px solid #1b2945;
          border-radius: 12px;
          box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
          z-index: 2147483647;
          overflow: hidden;
          max-height: 320px;
          overflow-y: auto;
          transform: translateY(-2px);
        }
        .focals-menu.open {
          display: flex;
        }
        .focals-item {
          padding: 10px 12px;
          background: transparent;
          border: none;
          color: #e9edf5;
          text-align: left;
          cursor: pointer;
          font-size: 14px;
        }
        .focals-item:hover {
          background: rgba(255, 255, 255, 0.06);
        }
        .focals-loader {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          border: 2px solid rgba(255, 255, 255, 0.6);
          border-top-color: #fff;
          animation: focals-spin 0.8s linear infinite;
        }
        @keyframes focals-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .focals-dialog-backdrop {
          position: fixed;
          inset: 0;
          display: none;
          align-items: center;
          justify-content: center;
          background: rgba(4, 9, 20, 0.55);
          backdrop-filter: blur(2px);
          z-index: 2147483647;
          padding: 16px;
        }
        .focals-dialog-backdrop.open {
          display: flex;
        }
        .focals-dialog {
          width: min(420px, 100%);
          background: #0f1b32;
          border: 1px solid #1b2945;
          border-radius: 16px;
          padding: 18px 16px;
          color: #e9edf5;
          box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
        }
        .focals-dialog h3 {
          margin: 0 0 6px;
          font-size: 16px;
        }
        .focals-dialog p {
          margin: 0 0 12px;
          color: #b6c2dc;
          font-size: 14px;
          line-height: 1.5;
        }
        .focals-dialog textarea {
          width: 100%;
          min-height: 90px;
          resize: vertical;
          background: #0a1328;
          color: #f6f8ff;
          border: 1px solid #1f3055;
          border-radius: 10px;
          padding: 10px;
          font-family: inherit;
          font-size: 14px;
          outline: none;
          transition: border-color 0.2s ease, box-shadow 0.2s ease;
        }
        .focals-dialog textarea:focus {
          border-color: #2f7dfc;
          box-shadow: 0 0 0 3px rgba(47, 125, 252, 0.18);
        }
        .focals-dialog .focals-actions {
          margin-top: 14px;
          display: flex;
          gap: 8px;
          justify-content: flex-end;
        }
        .focals-dialog .focals-secondary {
          background: transparent;
          color: #e9edf5;
          border: 1px solid #1f3055;
        }
        .focals-dialog button {
          border: none;
          border-radius: 12px;
          padding: 10px 14px;
          font-weight: 600;
          cursor: pointer;
          background: #2f7dfc;
          color: #fff;
          transition: background 0.2s ease, transform 0.1s ease;
        }
        .focals-dialog button:hover {
          background: #4a8bff;
        }
        .focals-dialog button:active {
          transform: translateY(1px);
        }
      `;

      const wrapper = document.createElement("div");
      wrapper.className = "focals-wrapper";

      const trigger = document.createElement("button");
      trigger.className = "focals-trigger";
      trigger.type = "button";
      const label = document.createElement("span");
      label.className = "focals-label";
      label.textContent = "Smart Reply";
      trigger.appendChild(label);

      const caret = document.createElement("span");
      caret.className = "focals-caret";
      caret.textContent = "▾";
      trigger.appendChild(caret);

      const loader = document.createElement("span");
      loader.className = "focals-loader";
      trigger.appendChild(loader);

      const menu = document.createElement("div");
      menu.className = "focals-menu";

      const setLoading = (isLoading) => {
        trigger.classList.toggle("is-loading", isLoading);
        trigger.disabled = isLoading;
        trigger.setAttribute("aria-busy", isLoading ? "true" : "false");
      };

      const runWithLoader = async (cb) => {
        setLoading(true);
        try {
          await cb();
        } finally {
          setLoading(false);
        }
      };

      const openCustomReplyDialog = () => {
        const backdrop = shadowRoot.querySelector(".focals-dialog-backdrop") || (() => {
          const el = document.createElement("div");
          el.className = "focals-dialog-backdrop";
          el.innerHTML = `
            <div class="focals-dialog" role="dialog" aria-modal="true">
              <h3>Custom reply</h3>
              <p>Ajoute des instructions personnalisées pour guider la réponse.</p>
              <textarea placeholder="Ex: Adopte un ton chaleureux et mentionne notre dernière discussion."></textarea>
              <div class="focals-actions">
                <button type="button" class="focals-secondary">Annuler</button>
                <button type="button" class="focals-primary">Valider</button>
              </div>
            </div>
          `;
          shadowRoot.appendChild(el);
          return el;
        })();

        const textarea = backdrop.querySelector("textarea");
        const cancelBtn = backdrop.querySelector(".focals-secondary");
        const submitBtn = backdrop.querySelector(".focals-primary");

        textarea.value = "";
        backdrop.classList.add("open");
        setTimeout(() => textarea.focus(), 0);

        return new Promise((resolve) => {
          const cleanup = () => {
            backdrop.classList.remove("open");
            cancelBtn.removeEventListener("click", onCancel);
            submitBtn.removeEventListener("click", onSubmit);
            backdrop.removeEventListener("click", onOutsideClick);
            textarea.removeEventListener("keydown", onKeyDown);
          };

          const onCancel = () => {
            cleanup();
            resolve(null);
          };

          const onSubmit = () => {
            const value = textarea.value.trim();
            cleanup();
            resolve(value);
          };

          const onOutsideClick = (event) => {
            if (event.target === backdrop) {
              onCancel();
            }
          };

          const onKeyDown = (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              onSubmit();
            }
          };

          cancelBtn.addEventListener("click", onCancel);
          submitBtn.addEventListener("click", onSubmit);
          backdrop.addEventListener("click", onOutsideClick);
          textarea.addEventListener("keydown", onKeyDown);
        });
      };

      const addItem = (label, handler, { requiresInstructions = false } = {}) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "focals-item";
        item.textContent = label;
        item.addEventListener("click", async () => {
          menu.classList.remove("open");
          if (typeof handler === "function") {
            if (requiresInstructions) {
              const instructions = await openCustomReplyDialog();
              if (instructions === null) return;
              await runWithLoader(() => handler(trigger, instructions));
              return;
            }

            await runWithLoader(() => handler(trigger));
          }
        });
        menu.appendChild(item);
      };

      addItem("Standard reply", options.onStandardReply);
      addItem("Custom reply", options.onCustomReply, { requiresInstructions: true });
      addItem("Personalized follow-up", options.onPersonalizedFollowup);

      trigger.addEventListener("click", (event) => {
        event.stopPropagation();
        menu.classList.toggle("open");
      });

      const closeMenu = (event) => {
        const composedPath = event.composedPath();
        if (composedPath.includes(menu) || composedPath.includes(trigger)) return;
        menu.classList.remove("open");
      };

      shadowRoot.addEventListener("click", closeMenu);
      document.addEventListener("click", closeMenu);

      wrapper.appendChild(trigger);
      wrapper.appendChild(menu);

      shadowRoot.appendChild(style);
      shadowRoot.appendChild(wrapper);
    };

    const getConversationRootFromButton = (buttonEl) => {
      if (!buttonEl) return null;
      const root = buttonEl.getRootNode();
      const host = (root instanceof ShadowRoot ? root.host : buttonEl);
      const conversationRoot = host.closest(
        ".msg-overlay-conversation-bubble, .msg-convo-wrapper"
      );
      return conversationRoot;
    };

    const getProfileLinkFromConversation = (conversationRoot) => {
      if (!conversationRoot) return null;

      const headerLink = conversationRoot.querySelector(
        'header a[href*="/in/"]'
      );
      if (headerLink) {
        return headerLink.getAttribute("href") || null;
      }

      const otherMsgLink = conversationRoot.querySelector(
        '.msg-s-event-listitem--other a[href*="/in/"]'
      );
      if (otherMsgLink) {
        return otherMsgLink.getAttribute("href") || null;
      }

      return null;
    };

    const extractThreadText = (conversationRoot) => {
      if (!conversationRoot) return "";

      const bubbles = conversationRoot.querySelectorAll(
        ".msg-s-event-listitem__body"
      );

      return Array.from(bubbles)
        .map((b) => (b.innerText || b.textContent || "").trim())
        .filter(Boolean)
        .join("\n\n");
    };

    const injectReplyIntoComposer = (conversationRoot, reply) => {
      if (!conversationRoot) return;

      const editor = conversationRoot.querySelector(
        '.msg-form__contenteditable[contenteditable="true"]'
      );
      if (!editor) {
        console.warn("[FOCALS] No message editor found in conversation");
        return;
      }

      editor.focus();
      editor.innerHTML = (reply || "").replace(/\n/g, "<br>");
      const inputEvent = new InputEvent("input", { bubbles: true, cancelable: true });
      editor.dispatchEvent(inputEvent);
    };

    const handlePersonalizedFollowup = async (buttonEl) => {
      try {
        const conversationRoot = getConversationRootFromButton(buttonEl);
        if (!conversationRoot) {
          console.warn(
            "[FOCALS] No conversation root found for personalized follow-up"
          );
          return;
        }

        const profileHref = getProfileLinkFromConversation(conversationRoot);
        if (!profileHref) {
          console.warn("[FOCALS] No profile link found in conversation");
          return;
        }

        const profileUrl = new URL(profileHref, window.location.origin).toString();
        const threadText = extractThreadText(conversationRoot);

        const reply = await backendGeneratePersonalizedFollowup({
          profileUrl,
          threadText,
        });

        if (!reply) {
          console.warn(
            "[FOCALS] backendGeneratePersonalizedFollowup returned empty reply"
          );
          return;
        }

        injectReplyIntoComposer(conversationRoot, reply);
      } catch (err) {
        console.error("[FOCALS] Error in handlePersonalizedFollowup", err);
      }
    };

    // --- FOCALS LINKEDIN MESSAGING PATCH (Shadow DOM Safe) ---
    const FOCALS_SR_ATTR = "data-focals-smart-reply";

    const injectSmartReplyIntoForm = (composer) => {
      const footerRightActions = composer.querySelector(".msg-form__right-actions");

      if (!footerRightActions) return false;

      if (footerRightActions.querySelector(`[${FOCALS_SR_ATTR}="1"]`)) return false;

      const host = document.createElement("div");
      host.className = BUTTON_CLASS;
      host.setAttribute(FOCALS_SR_ATTR, "1");
      footerRightActions.appendChild(host);

      const shadowRoot = host.attachShadow({ mode: "open" });
      const conversationRoot = resolveConversationRoot(composer);
      const conversationName = resolveConversationName(conversationRoot);

      renderSmartReplyMenu(shadowRoot, {
        onStandardReply: async (buttonEl) => {
          await runSuggestReplyPipeline({
            button: buttonEl,
            conversationRoot: conversationRoot || document,
            composer,
            conversationName,
            editorIndex: 1,
          });
        },
        onCustomReply: async (buttonEl, instructions) => {
          await runSuggestReplyPipeline({
            button: buttonEl,
            conversationRoot: conversationRoot || document,
            composer,
            conversationName,
            editorIndex: 1,
            customInstructions: instructions || "",
          });
        },
        onPersonalizedFollowup: handlePersonalizedFollowup,
      });

      return true;
    };

    const injectAllSmartReplyButtons = () => {
      const root = getLinkedinMessagingRoot();

      const formCandidates = Array.from(
        root.querySelectorAll("form.msg-form, form[data-test-msg-form]")
      );

      const footerCandidates = Array.from(
        root.querySelectorAll(".msg-form__footer")
      ).map((footer) => footer.closest("form") || footer.closest(".msg-form") || footer);

      const composers = Array.from(new Set([...formCandidates, ...footerCandidates])).filter(
        Boolean
      );

      let count = 0;
      for (const composer of composers) {
        if (injectSmartReplyIntoForm(composer)) count++;
      }

      if (count) console.log("[FOCALS SR] injected on forms:", count);
    };

    let focalsSrObsStarted = false;
    let focalsSrTimer = null;

    const setupMessagingObserver = () => {
      if (focalsSrObsStarted) return;
      focalsSrObsStarted = true;

      const root = getLinkedinMessagingRoot();

      console.log(
        "[FOCALS DEBUG] setupMessagingObserver on root =",
        root === document ? "document" : "interop-shadow-root"
      );

      const schedule = () => {
        clearTimeout(focalsSrTimer);
        focalsSrTimer = setTimeout(injectAllSmartReplyButtons, 80);
      };

      const observer = new MutationObserver(schedule);

      observer.observe(root, { childList: true, subtree: true });

      injectAllSmartReplyButtons();

      console.log("[FOCALS SR] observer ON");
    };

    const initMessagingWatcher = () => {
      console.log("[FOCALS DEBUG] messaging script bootstrap");
      setupMessagingObserver();
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
