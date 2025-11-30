(() => {
  const FOCALS_DEBUG = true;

  function debugLog(stage, details) {
    if (!FOCALS_DEBUG) return;
    try {
      if (typeof details === "string") {
        console.log(`[Focals][${stage}]`, details);
      } else {
        console.log(`[Focals][${stage}]`, JSON.stringify(details, null, 2));
      }
    } catch (e) {
      console.log(`[Focals][${stage}]`, details);
    }
  }

  function getEnvInfo() {
    const href = window.location.href;
    const origin = window.location.origin;
    const isTop = window === window.top;
    const isSandbox =
      document.origin === "null" ||
      window.location.origin === "null" ||
      !!window.frameElement?.hasAttribute("sandbox");

    return { href, origin, isTop, isSandbox };
  }

  const env = getEnvInfo();
  debugLog("ENV", env);

  if (!env.isTop) {
    debugLog("EXIT", "Not in top window, skipping Focals content script");
    return;
  }
  if (env.isSandbox) {
    debugLog("EXIT", "Sandboxed document, skipping Focals content script");
    return;
  }
  if (env.origin !== "https://www.linkedin.com") {
    debugLog("EXIT", `Not on linkedin.com (origin = ${env.origin}), skipping Focals content script`);
    return;
  }

  if (window.__FOCALS_CONTENT_MAIN_LOADED__) {
    debugLog("EXIT", "content-main.js already initialized");
    return;
  }
  window.__FOCALS_CONTENT_MAIN_LOADED__ = true;
  debugLog("INIT", "Safe content-main.js loaded");

  const STORAGE_KEYS = {
    tone: "focals_userTone",
    templates: "focals_templates",
    jobs: "focals_jobs",
    selectedTemplate: "focals_selectedTemplate",
    selectedJob: "focals_selectedJob",
  };

  const FOCALS_API_BASE = "https://ppawceknsedxaejpeylu.supabase.co/functions/v1";
  let lastScrapedProfile = null;
  let lastProfileUrl = null;
  let profileStatus = "idle";
  let lastHref = window.location.href;
  let currentScrapeToken = 0;

  function setProfileStatus(status) {
    profileStatus = status;
    debugLog("PROFILE_STATUS", { status, url: window.location.href });
  }

  async function callFocalsAPI(endpoint, payload) {
    const res = await fetch(`${FOCALS_API_BASE}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      debugLog("API_ERROR", { endpoint, errorMessage });
      throw new Error(errorMessage);
    }

    return res.json();
  }

  async function bootstrapUser(userId) {
    return callFocalsAPI("focals-bootstrap-user", { userId });
  }

  async function getAllData(userId) {
    return callFocalsAPI("focals-get-data", { userId });
  }

  async function upsertSettings(userId, partial) {
    return callFocalsAPI("focals-upsert-settings", { userId, ...partial });
  }

  async function upsertJob(userId, jobInput) {
    return callFocalsAPI("focals-upsert-job", { userId, job: jobInput });
  }

  async function deleteJob(userId, jobId) {
    return callFocalsAPI("focals-delete-job", { userId, jobId });
  }

  async function upsertTemplate(userId, templateInput) {
    return callFocalsAPI("focals-upsert-template", { userId, template: templateInput });
  }

  async function deleteTemplate(userId, templateId) {
    return callFocalsAPI("focals-delete-template", { userId, templateId });
  }

  async function generateReplyApi(request) {
    return callFocalsAPI("focals-generate-reply", request);
  }

  const USER_ID_STORAGE_KEY = "focals_user_id";
  let cachedUserId = null;

  async function getOrCreateUserId() {
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
  }

  const DEFAULT_TONE = "professional";
  const LANGUAGE_MARKERS = {
    fr: ["je", "vous", "merci", "bien", "bonjour", "j'", "n'", "est", "suis"],
    en: [" i ", " you ", "the", "and", "thanks", "hi", "hello", "not", "am"],
  };

  function normalizeSpace(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  const q = (selector) => document.querySelector(selector);
  const getText = (el) => (el ? el.innerText.trim() : "");
  const getAttr = (el, attr) => (el ? el.getAttribute(attr) : "");
  const pickText = (...selectors) => {
    for (const selector of selectors) {
      const value = getText(q(selector));
      if (value) return value;
    }
    return "";
  };
  const pickAttr = (selectors, attr) => {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const selector of list) {
      const el = q(selector);
      if (el) {
        const value = el.getAttribute(attr);
        if (value) return value.trim();
      }
    }
    return "";
  };
  const pickTextFrom = (root, selectors) => {
    if (!root) return "";
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const selector of list) {
      const el = root.querySelector(selector);
      if (el) {
        const text = getText(el);
        if (text) return text;
      }
    }
    return "";
  };
  const normalizeText = (text = "") => text.replace(/\s+/g, " ").trim();
  const firstNonEmpty = (...values) => values.find((v) => normalizeText(v)) || "";

  const isMessagingPage = () => /\/messaging\//.test(window.location.pathname);
  const linkedinScraper = window.__FocalsLinkedinScraper || {};

  const isProfilePage = (href = window.location.href) => {
    if (typeof linkedinScraper.isRecruiterProfile === "function" && linkedinScraper.isRecruiterProfile()) {
      return true;
    }
    if (typeof linkedinScraper.isPipelineProfile === "function" && linkedinScraper.isPipelineProfile()) {
      return true;
    }
    return /linkedin\.com\/in\//i.test(href);
  };

  function cleanNameText(text) {
    if (!text) return "";
    const collapsed = text.replace(/\s+/g, " ");
    const withoutEmoji = collapsed.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");
    return withoutEmoji.replace(/[^\p{L}\s\-']/gu, "").trim();
  }

  function extractFirstName(fullName) {
    if (!fullName) return null;
    const tokens = fullName
      .split(" ")
      .map((t) => t.trim())
      .filter(Boolean);
    const prefixes = ["mr", "m", "mme", "mrs", "ms", "dr", "m.", "mme."];
    const usable = tokens.filter((t) => !prefixes.includes(t.toLowerCase()));
    if (!usable.length) return null;
    const first = usable[0];
    if (!first) return null;
    const second = usable[1];
    if (second && /^[A-ZÀ-ÖØ-Ý]/.test(second) && second.length < 12) {
      return `${first} ${second}`;
    }
    return first;
  }

  function detectCandidateFirstNameFromDom() {
    const headerNode = document.querySelector("h2.msg-overlay-bubble-header__title .hoverable-link-text");
    const metaNode = document.querySelector(".msg-s-message-group__meta .msg-s-message-group__name");
    const headerText = headerNode?.innerText || headerNode?.textContent || "";
    const metaText = metaNode?.innerText || metaNode?.textContent || "";
    debugLog("NAME_HEADER_RAW", headerText);
    debugLog("NAME_META_RAW", metaText);

    const cleanedHeaderName = cleanNameText(headerText);
    const cleanedMetaName = cleanNameText(metaText);
    debugLog("NAME_HEADER_CLEAN", cleanedHeaderName);
    debugLog("NAME_META_CLEAN", cleanedMetaName);

    const headerFirst = extractFirstName(cleanedHeaderName);
    const metaFirst = extractFirstName(cleanedMetaName);

    const normalize = (value) =>
      (value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

    let firstName = null;
    let source = "none";
    let confidence = 0;

    if (headerFirst && metaFirst && normalize(headerFirst) === normalize(metaFirst)) {
      firstName = headerFirst;
      source = "both";
      confidence = 0.9;
    } else if (headerFirst) {
      firstName = headerFirst;
      source = "header";
      confidence = 0.7;
    } else if (metaFirst) {
      firstName = metaFirst;
      source = "meta";
      confidence = 0.7;
    }

    debugLog("NAME_FINAL", { firstName, source, confidence });
    return { fullHeaderName: cleanedHeaderName || null, fullMetaName: cleanedMetaName || null, firstName, source, confidence };
  }

  function countMarkers(text, markers) {
    const lower = ` ${normalizeSpace(text).toLowerCase()} `;
    let count = 0;
    markers.forEach((word) => {
      const regex = new RegExp(word.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g");
      const matches = lower.match(regex);
      if (matches) count += matches.length;
    });
    return count;
  }

  async function detectLanguage(text) {
    const snippet = (text || "").slice(0, 200);
    const frCount = countMarkers(text, LANGUAGE_MARKERS.fr);
    const enCount = countMarkers(text, LANGUAGE_MARKERS.en);
    let heuristic = "unknown";
    if (frCount > enCount * 2 && frCount >= 1) heuristic = "fr";
    if (enCount > frCount * 2 && enCount >= 1) heuristic = "en";
    if (heuristic === "fr" || heuristic === "en") {
      debugLog("LANG_DETECTION", { snippet, heuristic, result: heuristic });
      return heuristic;
    }

    let gptResult = "unknown";
    try {
      const response = await chrome.runtime.sendMessage({
        type: "FOCALS_ASK_GPT",
        prompt: `Detect the language of this message and respond with exactly 'fr' or 'en'.\nMessage: ${text}`,
        system: "You are a strict language detector. Only answer fr or en.",
        temperature: 0,
        maxTokens: 4,
      });
      if (response && (response.content === "fr" || response.content === "en")) {
        gptResult = response.content;
      }
    } catch (err) {
      debugLog("LANG_GPT_ERROR", err?.message || String(err));
    }

    debugLog("LANG_DETECTION", { snippet, heuristic, result: gptResult });
    if (gptResult === "fr" || gptResult === "en") return gptResult;
    return "unknown";
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "FOCALS_GET_PROFILE") {
      debugLog("MSG_GET_PROFILE", { hasProfile: !!lastScrapedProfile, status: profileStatus });
      sendResponse({ profile: lastScrapedProfile, status: profileStatus, url: lastProfileUrl });
      return true;
    }
    if (message?.type === "FOCALS_FORCE_RESCRAPE") {
      debugLog("PROFILE_FORCE_RESCRAPE", { url: window.location.href });
      triggerProfileScrape(true);
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  function parseCompanyAndContract(rawText = "") {
    const normalized = normalizeText(rawText);
    if (!normalized) return { company: "", contract: "" };
    const contractMatch = normalized.match(/(freelance|cdi|cdd|internship|stage|contract|apprentissage|alternance)/i);
    const contract = contractMatch ? contractMatch[1] : "";
    const withoutContract = normalized.replace(contractMatch ? contractMatch[0] : "", "").trim();
    return { company: withoutContract || normalized, contract: contract || "" };
  }

  function inferCurrentRole(headline = "", fallback = "") {
    const parts = normalizeText(headline).split("·");
    if (parts.length) {
      return parts[0] || fallback;
    }
    return fallback || headline;
  }

  function scrapeProfileFromDom() {
    const rawName =
      pickText(
        ".pv-text-details__left-panel h1",
        "div[data-view-name='profile-card'] h1",
        "main section h1.inline.t-24.v-align-middle.break-words",
        "h1.inline.t-24.v-align-middle.break-words",
        "a[href*='/overlay/about-this-profile/'] h1",
        ".text-heading-xlarge",
        "h1"
      ) ||
      pickAttr(
        [
          "a[href*='/overlay/about-this-profile/']",
          "a[href*='overlay/about-this-profile']",
          "a[href*='/overlay/contact-info/']",
        ],
        "aria-label"
      ) ||
      "";

    const name = normalizeText(rawName) || "—";
    const [firstName, ...restName] = name.split(/\s+/);
    const lastName = normalizeText(restName.join(" "));

    const headline =
      pickText(
        ".pv-text-details__left-panel .text-body-medium.break-words",
        ".text-body-medium.break-words",
        "div[data-view-name='profile-card'] .text-body-medium",
        ".display-flex.full-width .hoverable-link-text span[aria-hidden='true']",
        ".display-flex.full-width .hoverable-link-text"
      ) || "";

    const localisation =
      getText(q(".pv-text-details__left-panel .text-body-small.inline.t-black--light.break-words")) ||
      getText(q(".text-body-small.inline.t-black--light.break-words")) ||
      getText(q("div[data-view-name='profile-card'] .text-body-small")) ||
      "";

    const photo_url =
      getAttr(q(".pv-top-card-profile-picture__image"), "src") ||
      getAttr(q("img.pv-top-card-profile-picture__image--show"), "src") ||
      getAttr(q('meta[property="og:image"]'), "content") ||
      "";

    const topCardCompanyRaw =
      pickText(
        ".pv-text-details__left-panel .inline.t-16.t-black.t-normal span[aria-hidden='true']",
        ".pv-text-details__left-panel .inline.t-16.t-black.t-normal",
        ".display-flex.full-width .t-14.t-normal span[aria-hidden='true']",
        ".display-flex.full-width .t-14.t-normal",
        "div[data-view-name='profile-card'] .t-14.t-normal span[aria-hidden='true']",
        "div[data-view-name='profile-card'] .t-14.t-normal"
      ) ||
      pickAttr(
        [
          "div[data-view-name='profile-card'] a[href*='/company/']",
          "div[data-view-name='profile-card'] a[href*='/school/']",
          ".pv-text-details__left-panel a[href*='/company/']",
        ],
        "aria-label"
      );

    const topCardCompany = parseCompanyAndContract(topCardCompanyRaw);
    let current_company = topCardCompany.company;
    let contract = topCardCompany.contract;
    let current_title = headline || "";

    const experienceSection = (() => {
      const anchor = q("#experience");
      if (anchor) {
        const section = anchor.closest("section");
        if (section) return section;
      }
      const cards = Array.from(document.querySelectorAll("section.artdeco-card"));
      for (const card of cards) {
        const heading = pickTextFrom(card, ["h2 span[aria-hidden='true']", "h2"]);
        if (heading && /expérience/i.test(heading)) {
          return card;
        }
      }
      return null;
    })();

    if (experienceSection) {
      const listItems = Array.from(experienceSection.querySelectorAll("ul li"));
      let firstEntity = null;
      for (const item of listItems) {
        const entity = item.querySelector("[data-view-name='profile-component-entity']");
        if (entity) {
          firstEntity = entity;
          break;
        }
      }
      if (!firstEntity) {
        firstEntity = experienceSection.querySelector("[data-view-name='profile-component-entity']");
      }

      if (firstEntity) {
        const roleText = pickTextFrom(firstEntity, [".t-bold span[aria-hidden='true']", ".t-bold"]);
        const companyText = pickTextFrom(firstEntity, [".t-14.t-normal span[aria-hidden='true']", ".t-14.t-normal"]);
        if (roleText) current_title = normalizeText(roleText);
        if (companyText) {
          const parsed = parseCompanyAndContract(companyText);
          current_company = parsed.company || current_company;
          contract = parsed.contract || contract;
        }
      }
    }

    if (!current_title) {
      current_title = inferCurrentRole(headline, "");
    }

    const profile = {
      name: name || "—",
      firstName: normalizeText(firstName),
      lastName: lastName || "",
      headline: normalizeText(headline),
      current_title: normalizeText(current_title) || "—",
      current_company: normalizeText(current_company) || "—",
      contract: normalizeText(contract) || "—",
      localisation: normalizeText(localisation) || "—",
      linkedin_url: location.href,
      photo_url: photo_url || "",
    };

    lastScrapedProfile = profile;
    lastProfileUrl = window.location.href;
    debugLog("PROFILE_SCRAPED", profile);
    return profile;
  }

  const PROFILE_READY_SELECTORS = [
    ".pv-text-details__left-panel h1",
    "div[data-view-name='profile-card'] h1",
    "main section h1.inline.t-24.v-align-middle.break-words",
    "h1.inline.t-24.v-align-middle.break-words",
    "a[href*='/overlay/about-this-profile/'] h1",
    ".text-heading-xlarge",
    "main .pv-text-details__left-panel",
  ];

  async function runProfileScrape(force = false) {
    if (!isProfilePage()) {
      lastScrapedProfile = null;
      lastProfileUrl = null;
      setProfileStatus("idle");
      return;
    }

    if (!force && profileStatus === "ready" && lastProfileUrl === window.location.href) {
      return;
    }

    const token = ++currentScrapeToken;
    lastScrapedProfile = null;
    lastProfileUrl = window.location.href;
    setProfileStatus("loading");

    try {
      const domReady =
        typeof linkedinScraper.waitForDom === "function"
          ? await linkedinScraper.waitForDom()
          : await new Promise((resolve) => {
              const fallbackReady = PROFILE_READY_SELECTORS.some((selector) => document.querySelector(selector));
              resolve(fallbackReady);
            });
      if (token !== currentScrapeToken) return;
      if (!domReady) {
        setProfileStatus("error");
        return;
      }

      const source = linkedinScraper.isPipelineProfile?.()
        ? "pipeline"
        : linkedinScraper.isRecruiterProfile?.()
          ? "recruiter"
          : "public";
      debugLog("PROFILE_SOURCE", { source, url: window.location.href });

      let profile = null;
      if (source === "pipeline" && typeof linkedinScraper.scrapeRecruiterPipeline === "function") {
        profile = await linkedinScraper.scrapeRecruiterPipeline({ expectedTotal: 25 });
      } else if (typeof linkedinScraper.scrapePublicProfile === "function") {
        profile = linkedinScraper.scrapePublicProfile();
      } else {
        profile = scrapeProfileFromDom();
      }

      lastScrapedProfile = profile;
      debugLog("PROFILE_SCRAPED", { source: "historical", profile });
      if (token === currentScrapeToken) {
        setProfileStatus("ready");
      }
    } catch (err) {
      debugLog("PROFILE_SCRAPE_ERROR", err?.message || String(err));
      if (token === currentScrapeToken) {
        setProfileStatus("error");
      }
    }
  }

  function triggerProfileScrape(force = false) {
    runProfileScrape(force);
  }

  setProfileStatus(isProfilePage() ? "loading" : "idle");
  if (isProfilePage()) {
    triggerProfileScrape(true);
  }

  setInterval(() => {
    const currentHref = window.location.href;
    if (currentHref !== lastHref) {
      debugLog("PROFILE_URL_CHANGED", { from: lastHref, to: currentHref });
      lastHref = currentHref;
      if (isProfilePage(currentHref)) {
        triggerProfileScrape(true);
      } else {
        lastScrapedProfile = null;
        lastProfileUrl = null;
        setProfileStatus("idle");
      }
    }
  }, 1000);

  let cachedBootstrap = null;

  async function getUserId() {
    return getOrCreateUserId();
  }

  async function loadBootstrapData() {
    if (cachedBootstrap) return cachedBootstrap;
    const userId = await getUserId();
    try {
      cachedBootstrap = await bootstrapUser(userId);
    } catch (err) {
      debugLog("BOOTSTRAP_ERROR", err?.message || String(err));
      throw err;
    }
    return cachedBootstrap;
  }

  function buildGreeting(firstNameInfo, language) {
    if (language === "en") {
      if (firstNameInfo.firstName && firstNameInfo.confidence >= 0.75) {
        return `Hi ${firstNameInfo.firstName},`;
      }
      return "Hi,";
    }
    if (firstNameInfo.firstName && firstNameInfo.confidence >= 0.75) {
      return `Bonjour ${firstNameInfo.firstName},`;
    }
    return "Bonjour,";
  }

  async function safeGetStorage(area, keys, defaults = {}) {
    return new Promise((resolve) => {
      try {
        chrome.storage[area].get(keys, (result) => resolve({ ...defaults, ...(result || {}) }));
      } catch (err) {
        debugLog("STORAGE_ERROR", err?.message || String(err));
        resolve({ ...defaults });
      }
    });
  }

  async function loadTone() {
    const bootstrap = await loadBootstrapData();
    const values = await safeGetStorage("sync", [STORAGE_KEYS.tone]);
    const tone = bootstrap?.settings?.default_tone || values[STORAGE_KEYS.tone] || DEFAULT_TONE;
    const map = {
      very_formal: "Use a very formal and polite tone, similar to a corporate email.",
      professional: "Use a professional and polite tone.",
      warm: "Use a warm and friendly tone while staying professional.",
      direct: "Be concise and to the point, without being rude.",
    };
    const instruction = map[tone] || map[DEFAULT_TONE];
    debugLog("TONE", { tone, instruction });
    return { tone, instruction };
  }

  async function loadTemplatesAndJobs() {
    const bootstrap = await loadBootstrapData();
    const values = await safeGetStorage("sync", [
      STORAGE_KEYS.selectedTemplate,
      STORAGE_KEYS.selectedJob,
    ]);
    return {
      templates: Array.isArray(bootstrap?.templates) ? bootstrap.templates : [],
      jobs: Array.isArray(bootstrap?.jobs) ? bootstrap.jobs : [],
      selectedTemplate: values[STORAGE_KEYS.selectedTemplate] || null,
      selectedJob: values[STORAGE_KEYS.selectedJob] || bootstrap?.settings?.default_job_id || null,
    };
  }

  function extractLinkedInMessages(limit = 10) {
    const containers = document.querySelectorAll(
      [
        ".msg-s-message-list__event",
        ".msg-s-event-listitem",
        "[data-test-message-listitem]",
        ".msg-s-message-group",
      ].join(", ")
    );
    const messages = [];
    containers.forEach((container) => {
      const isFromMe =
        container.classList.contains("msg-s-message-list__event--self") ||
        container.classList.contains("msg-s-message-group--self") ||
        !!container.querySelector('[data-test-sender="self"]') ||
        !!container.closest(".msg-s-message-list__event--self");
      const textNode = container.querySelector(
        [
          ".msg-s-event-listitem__body",
          ".msg-s-message-group__content",
          "[data-test-message-text]",
          ".msg-s-event__content",
        ].join(", ")
      );
      const text = normalizeSpace(textNode?.innerText || textNode?.textContent || "");
      if (!text) return;
      const timeEl = container.querySelector("time, .msg-s-message-list__time-heading");
      const timestamp = timeEl ? new Date(timeEl.getAttribute("datetime") || timeEl.innerText).getTime() : Date.now();
      messages.push({ text, fromMe: isFromMe, timestamp });
    });
    const recent = messages.slice(-limit);
    debugLog("MESSAGES", { total: messages.length, recent: recent.length });
    return recent;
  }

  function insertReplyIntoMessageInput(replyText) {
    const inputSelectors = [
      ".msg-form__contenteditable",
      "[data-test-message-input]",
      '.msg-form__message-texteditor [contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
    ];

    let inputField = null;
    for (const selector of inputSelectors) {
      inputField = document.querySelector(selector);
      if (inputField) break;
    }

    if (!inputField) {
      debugLog("INPUT", "Message input not found; copying to clipboard");
      try {
        navigator.clipboard.writeText(replyText).then(() => {
          alert("Réponse copiée dans le presse-papier. Collez-la dans LinkedIn.");
        });
      } catch (err) {
        debugLog("CLIPBOARD_ERROR", err?.message || String(err));
      }
      return false;
    }

    try {
      inputField.focus();
      inputField.innerHTML = "";
      document.execCommand("insertText", false, replyText);
      if (!inputField.innerText || inputField.innerText.trim().length === 0) {
        inputField.innerText = replyText;
        inputField.dispatchEvent(new Event("input", { bubbles: true }));
        inputField.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(inputField);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      debugLog("INPUT", "Reply inserted into composer");
      return true;
    } catch (err) {
      debugLog("INPUT_ERROR", err?.message || String(err));
      return false;
    }
  }

  function setButtonsLoading(isLoading, label = "") {
    const replyBtn = document.getElementById("focals-reply-btn");
    const softBtn = document.getElementById("focals-soft-btn");
    const strongBtn = document.getElementById("focals-strong-btn");
    const toggleButton = (btn, baseLabel) => {
      if (!btn) return;
      btn.disabled = isLoading;
      btn.textContent = isLoading && label ? label : baseLabel;
      btn.style.opacity = isLoading ? "0.7" : "1";
    };
    toggleButton(replyBtn, "Suggest reply");
    toggleButton(softBtn, "Relance douce");
    toggleButton(strongBtn, "Relance forte");
  }

  function applyTemplate(templateContent, { firstNameInfo, job }) {
    let content = templateContent || "";
    const replacements = {
      firstName: firstNameInfo.firstName || "",
      company: job?.company || "",
      role: job?.title || "",
    };
    Object.entries(replacements).forEach(([key, value]) => {
      content = content.replace(new RegExp(`{${key}}`, "g"), value || "");
    });
    return content;
  }

  function buildFollowUpSummary(messages) {
    const summary = [];
    messages.slice(-10).forEach((msg) => {
      summary.push(`${msg.fromMe ? "Me" : "Candidate"}: ${msg.text.slice(0, 120)}`);
    });
    return summary.join("\n");
  }

  async function generateReply({ templateId, jobId }) {
    const allMessages = extractLinkedInMessages(10);
    if (!allMessages.length) {
      alert("Aucun message détecté dans la conversation.");
      return;
    }

    const candidateMessages = allMessages.filter((m) => !m.fromMe);
    const snippet = candidateMessages.map((m) => m.text).slice(-3).join("\n");
    const language = (await detectLanguage(snippet)) || "unknown";
    const languageFinal = language === "unknown" ? "fr" : language;

    const firstNameInfo = detectCandidateFirstNameFromDom();
    const { tone } = await loadTone();
    const { templates, jobs } = await loadTemplatesAndJobs();
    const selectedTemplate = templates.find((t) => t.id === templateId) || null;
    const selectedJob = jobs.find((j) => j.id === jobId) || null;

    const templateText = selectedTemplate
      ? applyTemplate(selectedTemplate.content, { firstNameInfo, job: selectedJob })
      : null;

    const messagesPayload = allMessages.map((m) => ({
      senderType: m.fromMe ? "me" : "candidate",
      text: m.text,
      createdAt: new Date(m.timestamp || Date.now()).toISOString(),
    }));

    const request = {
      userId: await getUserId(),
      mode: "initial",
      conversation: {
        messages: messagesPayload,
        candidateFirstName: firstNameInfo.firstName || null,
        language: languageFinal,
      },
      toneOverride: tone,
      jobId: selectedJob?.id || undefined,
      templateId: selectedTemplate?.id || null,
      templateContentOverride: templateText,
    };

    try {
      setButtonsLoading(true, "Génération...");
      const { replyText } = await generateReplyApi(request);
      if (!replyText) {
        alert("Impossible de générer une réponse.");
        return;
      }
      insertReplyIntoMessageInput(replyText);
    } catch (error) {
      console.error("[Focals] generate-reply error", error);
      alert(`Erreur Focals : ${error?.message || "Une erreur est survenue."}`);
    } finally {
      setButtonsLoading(false);
    }
  }

  async function generateFollowUp({ strength, templateId, jobId }) {
    const allMessages = extractLinkedInMessages(10);
    const candidateMessages = allMessages.filter((m) => !m.fromMe);
    const snippet = candidateMessages.map((m) => m.text).slice(-3).join("\n");
    const language = (await detectLanguage(snippet)) || "unknown";
    const languageFinal = language === "unknown" ? "fr" : language;
    const firstNameInfo = detectCandidateFirstNameFromDom();

    const { tone } = await loadTone();
    const { templates, jobs } = await loadTemplatesAndJobs();
    const selectedTemplate = templates.find((t) => t.id === templateId) || null;
    const selectedJob = jobs.find((j) => j.id === jobId) || null;

    const templateText = selectedTemplate
      ? applyTemplate(selectedTemplate.content, { firstNameInfo, job: selectedJob })
      : null;

    const messagesPayload = allMessages.map((m) => ({
      senderType: m.fromMe ? "me" : "candidate",
      text: m.text,
      createdAt: new Date(m.timestamp || Date.now()).toISOString(),
    }));

    const request = {
      userId: await getUserId(),
      mode: strength === "strong" ? "followup_strong" : "followup_soft",
      conversation: {
        messages: messagesPayload,
        candidateFirstName: firstNameInfo.firstName || null,
        language: languageFinal,
      },
      toneOverride: tone,
      jobId: selectedJob?.id || undefined,
      templateId: selectedTemplate?.id || null,
      templateContentOverride: templateText,
    };

    try {
      setButtonsLoading(true, "Génération...");
      const { replyText } = await generateReplyApi(request);
      if (!replyText) {
        alert("Impossible de générer la relance.");
        return;
      }
      insertReplyIntoMessageInput(replyText);
    } catch (error) {
      console.error("[Focals] generate-followup error", error);
      alert(`Erreur Focals : ${error?.message || "Une erreur est survenue."}`);
    } finally {
      setButtonsLoading(false);
    }
  }

  function buildControlPanel(state) {
    if (document.getElementById("focals-controls")) return;
    const container = document.createElement("div");
    container.id = "focals-controls";
    container.style.position = "fixed";
    container.style.bottom = "16px";
    container.style.right = "16px";
    container.style.zIndex = "2147483647";
    container.style.background = "rgba(17,24,39,0.96)";
    container.style.color = "#fff";
    container.style.padding = "12px";
    container.style.border = "1px solid #334155";
    container.style.borderRadius = "12px";
    container.style.boxShadow = "0 10px 30px rgba(0,0,0,0.3)";
    container.style.width = "280px";
    container.style.fontFamily = "system-ui, sans-serif";

    const title = document.createElement("div");
    title.textContent = "Focals";
    title.style.fontWeight = "700";
    title.style.marginBottom = "8px";
    container.appendChild(title);

    const templateSelect = document.createElement("select");
    templateSelect.style.width = "100%";
    templateSelect.style.marginBottom = "6px";
    const defaultTpl = document.createElement("option");
    defaultTpl.value = "";
    defaultTpl.textContent = "Aucun modèle";
    templateSelect.appendChild(defaultTpl);
    state.templates.forEach((tpl) => {
      const opt = document.createElement("option");
      opt.value = tpl.id;
      opt.textContent = `${tpl.label || tpl.id} (${tpl.language})`;
      if (tpl.id === state.selectedTemplate) opt.selected = true;
      templateSelect.appendChild(opt);
    });

    const jobSelect = document.createElement("select");
    jobSelect.style.width = "100%";
    jobSelect.style.marginBottom = "6px";
    const defaultJob = document.createElement("option");
    defaultJob.value = "";
    defaultJob.textContent = "Aucun job";
    jobSelect.appendChild(defaultJob);
    state.jobs.forEach((job) => {
      const opt = document.createElement("option");
      opt.value = job.id;
      opt.textContent = `${job.title} @ ${job.company}`;
      if (job.id === state.selectedJob) opt.selected = true;
      jobSelect.appendChild(opt);
    });

    const replyBtn = document.createElement("button");
    replyBtn.id = "focals-reply-btn";
    replyBtn.textContent = "Suggest reply";
    replyBtn.style.width = "100%";
    replyBtn.style.padding = "10px";
    replyBtn.style.background = "#22c55e";
    replyBtn.style.border = "none";
    replyBtn.style.borderRadius = "10px";
    replyBtn.style.color = "#0f172a";
    replyBtn.style.fontWeight = "700";
    replyBtn.style.cursor = "pointer";
    replyBtn.style.marginTop = "6px";

    const followRow = document.createElement("div");
    followRow.style.display = "flex";
    followRow.style.gap = "6px";
    followRow.style.marginTop = "6px";

    const softBtn = document.createElement("button");
    softBtn.id = "focals-soft-btn";
    softBtn.textContent = "Relance douce";
    softBtn.style.flex = "1";
    softBtn.style.background = "#3b82f6";
    softBtn.style.border = "none";
    softBtn.style.borderRadius = "10px";
    softBtn.style.color = "#fff";
    softBtn.style.cursor = "pointer";

    const strongBtn = document.createElement("button");
    strongBtn.id = "focals-strong-btn";
    strongBtn.textContent = "Relance forte";
    strongBtn.style.flex = "1";
    strongBtn.style.background = "#ef4444";
    strongBtn.style.border = "none";
    strongBtn.style.borderRadius = "10px";
    strongBtn.style.color = "#fff";
    strongBtn.style.cursor = "pointer";

    const info = document.createElement("div");
    info.style.fontSize = "12px";
    info.style.color = "#cbd5e1";
    info.style.marginTop = "6px";
    info.textContent = `Ton: ${state.tone || DEFAULT_TONE}`;

    templateSelect.addEventListener("change", () => {
      const value = templateSelect.value || null;
      state.selectedTemplate = value;
      try {
        chrome.storage.sync.set({ [STORAGE_KEYS.selectedTemplate]: value });
      } catch (err) {
        debugLog("STORAGE_ERROR", err?.message || String(err));
      }
    });

    jobSelect.addEventListener("change", () => {
      const value = jobSelect.value || null;
      state.selectedJob = value;
      try {
        chrome.storage.sync.set({ [STORAGE_KEYS.selectedJob]: value });
      } catch (err) {
        debugLog("STORAGE_ERROR", err?.message || String(err));
      }
    });

    replyBtn.onclick = () => {
      generateReply({ templateId: templateSelect.value || null, jobId: jobSelect.value || null });
    };
    softBtn.onclick = () => {
      generateFollowUp({ strength: "soft", templateId: templateSelect.value || null, jobId: jobSelect.value || null });
    };
    strongBtn.onclick = () => {
      generateFollowUp({ strength: "strong", templateId: templateSelect.value || null, jobId: jobSelect.value || null });
    };

    container.appendChild(templateSelect);
    container.appendChild(jobSelect);
    container.appendChild(replyBtn);
    followRow.appendChild(softBtn);
    followRow.appendChild(strongBtn);
    container.appendChild(followRow);
    container.appendChild(info);

    document.body.appendChild(container);
  }

  async function initConversationFlow() {
    debugLog("MODE", "conversation");
    const { templates, jobs, selectedTemplate, selectedJob } = await loadTemplatesAndJobs();
    const toneData = await loadTone();
    buildControlPanel({
      templates,
      jobs,
      selectedTemplate,
      selectedJob,
      tone: toneData.tone,
    });
  }

  async function initProfileFlow() {
    debugLog("MODE", "profile");
    triggerProfileScrape(true);
  }

  async function init() {
    if (isMessagingPage()) {
      await initConversationFlow();
      return;
    }

    if (isProfilePage()) {
      await initProfileFlow();
      return;
    }

    debugLog("MODE", "unsupported-context");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
