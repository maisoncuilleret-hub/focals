(() => {
  if (window.__FOCALS_CONTENT_MAIN_LOADED__) {
    console.log("[Focals] content-main.js already initialized");
    return;
  }
  window.__FOCALS_CONTENT_MAIN_LOADED__ = true;

  console.log("[Focals] Safe content-main.js loaded");

  // Simple sélecteurs
  const q = (s) => document.querySelector(s);
  const getText = (el) => (el ? el.innerText.trim() : "");
  const getAttr = (el, attr) => (el ? el.getAttribute(attr) : "");
  const pickText = (...selectors) => {
    for (const selector of selectors) {
      const text = getText(q(selector));
      if (text) {
        return text;
      }
    }
    return "";
  };
  const pickAttr = (selectors, attr) => {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const selector of list) {
      const el = q(selector);
      if (el) {
        const value = el.getAttribute(attr);
        if (value) {
          return value.trim();
        }
      }
    }
    return "";
  };
  const pickAttrFrom = (root, selectors, attr) => {
    if (!root) return "";
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const selector of list) {
      const el = root.querySelector(selector);
      if (el) {
        const value = el.getAttribute(attr);
        if (value) {
          return value.trim();
        }
      }
    }
    return "";
  };
  const normalizeText = (text) => (text || "").replace(/\s+/g, " ").trim();
  const pickTextFrom = (root, selectors) => {
    if (!root) return "";
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const selector of list) {
      const el = root.querySelector(selector);
      const text = getText(el);
      if (text) {
        return text;
      }
    }
    return "";
  };
  const wait = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  const randomBetween = (min, max) => min + Math.random() * (max - min);
  const sendRuntimeMessage = (message) => {
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.then === "function") {
        return result;
      }
    } catch (err) {
      // ignore messaging failures (e.g. background stopped)
    }
    return Promise.resolve();
  };
  const pipelineProgress = (requestId, payload = {}) => {
    if (!requestId) return;
    sendRuntimeMessage({ type: "PIPELINE_EXPORT_PROGRESS", requestId, ...payload });
  };
  const firstNonEmpty = (...values) => {
    for (const value of values) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) {
          return trimmed;
        }
      }
    }
    return "";
  };
  const cleanMetadataValue = (text) => normalizeText((text || "").replace(/^·\s*/, ""));
  const pickRoleText = (node) => {
    if (!node) return "";
    const fromSelectors = pickTextFrom(node, [
      ".display-flex.full-width .hoverable-link-text span[aria-hidden='true']",
      ".hoverable-link-text span[aria-hidden='true']",
      ".hoverable-link-text",
      ".t-bold span[aria-hidden='true']",
      ".t-bold",
    ]);
    if (fromSelectors) {
      return fromSelectors;
    }
    const bolds = node.querySelectorAll(".t-bold");
    for (const bold of bolds) {
      const text = getText(bold);
      if (text) {
        return text;
      }
    }
    return "";
  };
  const isDurationText = (text) => {
    if (!text) return false;
    const normalized = text
      .toLowerCase()
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return /\b(ans?|ann[ée]e?s?|mois|years?|months?|an[s ]+\d|\d+\s*(ans|an|mois|years|year|months|month))/.test(normalized);
  };
  const pickCompanyText = (node) => {
    if (!node) return "";
    const anchor = node.querySelector("a[data-field='experience_company_logo']");
    if (anchor) {
      const anchorCandidates = anchor.querySelectorAll(".t-14.t-normal");
      for (const candidate of anchorCandidates) {
        if (candidate.classList.contains("t-black--light")) continue;
        const text = getText(candidate);
        if (text && !isDurationText(text)) {
          return text;
        }
      }
      const ariaText = anchor.getAttribute("aria-label");
      if (ariaText) {
        return ariaText.trim();
      }
    }

    const candidates = node.querySelectorAll(".t-14.t-normal");
    for (const candidate of candidates) {
      if (candidate.classList.contains("t-black--light")) continue;
      const text = getText(candidate);
      if (text && !isDurationText(text)) {
        return text;
      }
    }

    return pickTextFrom(node, [
      "a[data-field='experience_company_logo'] span[aria-hidden='true']",
      "a[data-field='experience_company_logo']",
    ]);
  };
  const parseConnectionDegree = (text) => {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) {
      return { degree: "", status: "unknown" };
    }

    const markers = [
      { regex: /\b1(?:er|re|st|ère)\b|premier|first|1st|1er/, degree: "1er", status: "connected" },
      { regex: /\b2(?:e|nd|ème)\b|deuxi[eè]me|second|second-degree|2nd|relation de 2/, degree: "2e", status: "not_connected" },
      { regex: /\b3(?:e|rd|ème)\b|troisi[eè]me|third|3rd|relation de 3/, degree: "3e", status: "not_connected" },
    ];

    for (const marker of markers) {
      if (marker.regex.test(normalized)) {
        return { degree: marker.degree, status: marker.status };
      }
    }

    if (/suivi|follower/.test(normalized)) {
      return { degree: "Follower", status: "not_connected" };
    }
    if (/hors du r[ée]seau|out of network|hors r[ée]seau/.test(normalized)) {
      return { degree: "Hors réseau", status: "not_connected" };
    }

    return { degree: normalizeText(text), status: "unknown" };
  };
  const collectTopCardButtons = () => {
    const selector = [
      ".pv-top-card button",
      ".pv-top-card-v2-ctas button",
      ".pvs-profile-actions__action button",
      ".pvs-profile-actions__custom-action",
      ".pvs-profile-actions__custom button",
      ".pvs-profile-actions button",
      "[data-test-profile-top-card] button",
      "[data-test-profile-actions] button",
      "[data-test-top-card-actions] button",
      ".artdeco-entity-lockup button",
      ".lockup__content-title-right-container button",
      ".profile-item-actions button",
      ".topcard-condensed__actions button",
      "[data-live-test-profile-item-actions] button",
    ].join(", ");
    return Array.from(document.querySelectorAll(selector));
  };
  const computeConnectionInfo = () => {
    const premiumBadge =
      q(".pv-member-badge--for-top-card") ||
      document.querySelector("svg[data-test-icon*='linkedin-bug-premium']") ||
      document.querySelector("svg[data-test-icon='linkedin-bug-premium-xsmall']");
    const isPremium = !!premiumBadge;

    const badgeCandidates = [];
    const pushCandidate = (node) => {
      if (node) {
        badgeCandidates.push(node);
      }
    };
    pushCandidate(q(".distance-badge"));
    pushCandidate(q("[data-test-lockup-degree]"));
    const lockupBadges = Array.from(document.querySelectorAll(".artdeco-entity-lockup__badge"));
    const degreeBadge = lockupBadges.find((node) => node.querySelector(".artdeco-entity-lockup__degree"));
    pushCandidate(degreeBadge);
    const labelledBadge = lockupBadges.find((node) => /(relation|degree|degr[ée])/i.test(node.innerText || ""));
    pushCandidate(labelledBadge);
    const badge = badgeCandidates.find(Boolean);
    const labelCandidates = [];
    if (badge) {
      labelCandidates.push(getText(badge.querySelector(".visually-hidden")));
      labelCandidates.push(getText(badge.querySelector(".a11y-text")));
      labelCandidates.push(getText(badge.querySelector(".dist-value")));
      labelCandidates.push(getText(badge));
    }
    const connectionLabel = firstNonEmpty(...labelCandidates);
    const degreeInfo = parseConnectionDegree(connectionLabel);
    let connectionStatus = degreeInfo.status;
    let connectionDegree = degreeInfo.degree;

    if ((!connectionLabel || connectionStatus === "unknown") && badge) {
      const fallbackText = getText(badge.querySelector(".dist-value"));
      if (fallbackText) {
        const fallbackInfo = parseConnectionDegree(fallbackText);
        if (!connectionDegree) connectionDegree = fallbackInfo.degree;
        if (connectionStatus === "unknown" && fallbackInfo.status !== "unknown") {
          connectionStatus = fallbackInfo.status;
        }
      }
    }

    const buttons = collectTopCardButtons();
    const buttonTexts = buttons.map((btn) => normalizeText(btn ? btn.innerText || btn.textContent : "")).filter(Boolean);
    const lowerButtonTexts = buttonTexts.map((text) => text.toLowerCase());
    const hasConnectButton = lowerButtonTexts.some((text) => /se connecter|connect|conectar|connettersi/.test(text));
    const hasFollowButton = lowerButtonTexts.some((text) => /suivre|follow/.test(text));
    const hasMessageButton = lowerButtonTexts.some((text) => /message|messagerie|inmail|envoyer un message|send message/.test(text));

    if (connectionStatus === "unknown") {
      if (hasConnectButton || hasFollowButton) {
        connectionStatus = "not_connected";
      } else if (hasMessageButton) {
        connectionStatus = "connected";
      }
    }

    const canMessageWithoutConnect =
      connectionStatus !== "connected" &&
      hasMessageButton &&
      (connectionStatus === "not_connected" || hasConnectButton || hasFollowButton || isPremium);

    const summaryParts = [];
    if (connectionStatus === "connected") {
      summaryParts.push("Connecté");
    } else if (connectionStatus === "not_connected") {
      summaryParts.push("Non connecté");
    }
    if (connectionDegree) {
      summaryParts.push(connectionDegree);
    } else if (connectionLabel && (!summaryParts.length || summaryParts[summaryParts.length - 1] !== connectionLabel)) {
      summaryParts.push(connectionLabel);
    }
    if (canMessageWithoutConnect && connectionStatus !== "connected") {
      summaryParts.push("Message direct possible");
    }

    const connectionSummary = normalizeText(summaryParts.join(" · "));

    return {
      connection_status: connectionStatus,
      connection_degree: connectionDegree,
      connection_label: connectionLabel,
      is_premium: isPremium,
      can_message_without_connect: canMessageWithoutConnect,
      connection_summary: connectionSummary,
    };
  };

  const extractAttributeValue = (element, matcher) => {
    if (!element) return "";
    const attrNames = element.getAttributeNames ? element.getAttributeNames() : [];
    for (const name of attrNames) {
      const value = element.getAttribute(name);
      if (value && matcher(name, value)) {
        return value.trim();
      }
    }
    if (element.dataset) {
      for (const [key, value] of Object.entries(element.dataset)) {
        if (value && matcher(key, value)) {
          return value.trim();
        }
      }
    }
    return "";
  };

  const findPublicProfileUrl = () => {
    const candidateSelectors = [
      "a[data-test-public-profile-link]",
      ".artdeco-hoverable-content a[data-test-public-profile-link]",
      "a.topcard-condensed__public-profile-hovercard",
    ];

    for (const selector of candidateSelectors) {
      const el = document.querySelector(selector);
      const href = el ? el.getAttribute("href") : "";
      if (href && /linkedin\.com\/in\//i.test(href)) {
        return href.trim();
      }
    }

    const copyButton = document.querySelector("button[data-test-copy-public-profile-link-btn]");
    const copyValue = extractAttributeValue(copyButton, (name, value) =>
      /clipboard|public[-_]?profile|link/i.test(name) && /linkedin\.com\//i.test(value)
    );
    if (copyValue) {
      return copyValue;
    }

    const trigger =
      document.querySelector("[data-test-public-profile-trigger]") ||
      document.querySelector("#topcard-public-profile-hoverable-btn");
    const triggerValue = extractAttributeValue(trigger, (name, value) =>
      /public[-_]?profile|link|href/i.test(name) && /linkedin\.com\/in\//i.test(value)
    );
    if (triggerValue) {
      return triggerValue;
    }

    const metadataSelectors = [
      'meta[property="og:url"]',
      'meta[name="twitter:url"]',
      'link[rel="canonical"]',
    ];
    for (const selector of metadataSelectors) {
      const node = document.querySelector(selector);
      const value = getAttr(node, "content") || getAttr(node, "href");
      if (value && /linkedin\.com\/in\//i.test(value)) {
        return value.trim();
      }
    }

    const genericLinks = Array.from(document.querySelectorAll("a[href*='linkedin.com/in/']"));
    for (const link of genericLinks) {
      const href = link.getAttribute("href");
      if (!href) continue;
      const inTopCard = !!link.closest(
        ".profile__topcard-wrapper, .lockup, .artdeco-entity-lockup, [data-test-row-lockup-full-name]"
      );
      if (inTopCard || /topcard|profil public|public profile/i.test(link.outerHTML)) {
        return href.trim();
      }
    }

    return "";
  };

  const openPublicProfileFlyout = async () => {
    const trigger =
      document.querySelector("[data-test-public-profile-trigger]") ||
      document.querySelector("#topcard-public-profile-hoverable-btn");
    if (!trigger) {
      return false;
    }

    try {
      trigger.scrollIntoView({ behavior: "instant", block: "center" });
    } catch (err) {
      // ignore scroll issues
    }

    const hoverEvents = ["mouseenter", "mouseover", "focusin", "focus"];
    for (const type of hoverEvents) {
      try {
        trigger.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, view: window })
        );
      } catch (err) {
        // ignore synthetic event failures
      }
    }

    await wait(randomBetween(140, 220));

    try {
      trigger.click();
    } catch (err) {
      // ignore click failures
    }

    await wait(randomBetween(150, 240));

    const copyButton = document.querySelector("button[data-test-copy-public-profile-link-btn]");
    if (copyButton) {
      for (const type of hoverEvents) {
        try {
          copyButton.dispatchEvent(
            new MouseEvent(type, { bubbles: true, cancelable: true, view: window })
          );
        } catch (err) {
          // ignore synthetic event failures
        }
      }
    }

    return true;
  };
  const detectContract = (text) => {
    const normalized = (text || "").toLowerCase();
    if (/\bcdi\b/.test(normalized)) return "CDI";
    if (/\bcdd\b/.test(normalized)) return "CDD";
    if (/freelance|indépendant|independant/.test(normalized)) return "Freelance";
    if (/\bstage\b/.test(normalized)) return "Stage";
    if (/alternance/.test(normalized)) return "Alternance";
    return "";
  };
  const parseCompanyAndContract = (rawText) => {
    const trimmed = (rawText || "").trim();
    if (!trimmed) {
      return { company: "", contract: "" };
    }
    const parts = trimmed.split("·").map((part) => part.trim()).filter(Boolean);
    let company = parts[0] || trimmed;
    let contract = "";
    for (const part of parts.slice(1)) {
      const detected = detectContract(part);
      if (detected) {
        contract = detected;
        break;
      }
    }
    if (!contract) {
      contract = detectContract(trimmed);
    }
    if (contract && company && detectContract(company) === contract) {
      company = "";
    }
    return { company, contract };
  };
  const findHistorySummary = (root, matcher) => {
    if (!root) return "";
    const groups = Array.from(root.querySelectorAll(".history-group"));
    for (const group of groups) {
      const heading = normalizeText(
        firstNonEmpty(
          pickTextFrom(group, [".history-group__definition"]),
          pickTextFrom(group, [".history-group__term"])
        )
      );
      if (heading && matcher.test(heading)) {
        const firstItem = group.querySelector(".history-group__list-items li");
        if (firstItem) {
          return normalizeText(firstItem.textContent || "");
        }
      }
    }
    return "";
  };
  const parseRoleAndCompanyFromSummary = (summary) => {
    if (!summary) return { role: "", company: "" };
    const firstPart = summary.split("·")[0] || "";
    const match = firstPart.match(/^(.*?)(?:\s+(?:chez|at)\s+(.*))?$/i);
    if (match) {
      return {
        role: normalizeText(match[1] || ""),
        company: normalizeText(match[2] || ""),
      };
    }
    return { role: normalizeText(firstPart), company: "" };
  };
  const decodeHtmlEntities = (() => {
    const textarea = document.createElement("textarea");
    return (value) => {
      if (typeof value !== "string") return "";
      textarea.innerHTML = value;
      return textarea.value;
    };
  })();
  const decodeJsonString = (value) => {
    if (typeof value !== "string") {
      return "";
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    try {
      const parsed = JSON.parse(`"${trimmed.replace(/"/g, '\\"')}"`);
      return decodeHtmlEntities(parsed);
    } catch (err) {
      return decodeHtmlEntities(
        trimmed
          .replace(/\\u002F/g, "/")
          .replace(/\\\//g, "/")
          .replace(/\\"/g, '"')
          .replace(/\\n/g, " ")
          .replace(/\\t/g, " ")
      );
    }
  };
  const normalizeNameKey = (name) => {
    if (!name) return "";
    return name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  };
  const slugifyName = (name) => {
    if (!name) return "";
    return name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  };
  let publicProfileCache = null;
  const buildPublicProfileIndex = () => {
    const html = document.documentElement.innerHTML || "";
    const signature = `${html.length}:${document.querySelectorAll("article.profile-list-item").length}`;
    if (publicProfileCache && publicProfileCache.signature === signature) {
      return publicProfileCache.map;
    }

    const map = new Map();
    const regex = /"publicProfileUrl":"(https:\/\/[^"]+)"[^{}]*?"firstName":"([^"]*)"[^{}]*?"lastName":"([^"]*)"/g;
    let match;
    while ((match = regex.exec(html))) {
      const url = sanitizeLinkedinUrl(decodeJsonString(match[1]));
      if (!/linkedin\.com\/in\//i.test(url)) {
        continue;
      }
      const first = decodeJsonString(match[2]);
      const last = decodeJsonString(match[3]);
      const key = normalizeNameKey(`${first} ${last}`);
      if (!key) continue;
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key).push(url);
    }

    publicProfileCache = { signature, map };
    return map;
  };
  const sanitizeLinkedinUrl = (value) => {
    if (!value) return "";
    let cleaned = decodeHtmlEntities(value.trim());
    cleaned = cleaned
      .replace(/\\u002F/g, "/")
      .replace(/\\\//g, "/")
      .replace(/\\"/g, '"')
      .replace(/\\n/g, " ")
      .replace(/\\t/g, " ")
      .replace(/\\/g, "");
    const urlMatch = cleaned.match(/https?:\/\/[^\s"'<>]+/i);
    if (urlMatch) {
      cleaned = urlMatch[0];
    }
    cleaned = cleaned.replace(/&amp;/gi, "&").replace(/\u00a0/g, "");
    if (cleaned.startsWith("//")) {
      cleaned = `https:${cleaned}`;
    }
    if (/^https?:\/\//i.test(cleaned)) {
      return cleaned;
    }
    if (cleaned.startsWith("www.")) {
      return `https://${cleaned}`;
    }
    return cleaned;
  };
  const findPublicProfileUrlInTree = (root) => {
    if (!root) return "";
    const queue = [root];
    while (queue.length) {
      const node = queue.shift();
      if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.getAttributeNames) {
        for (const attrName of node.getAttributeNames()) {
          const attrValue = node.getAttribute(attrName);
          if (
            attrValue &&
            /public.*profile|profileurl|profile-link|profilehref|data-url/i.test(attrName) &&
            /linkedin\.com\/in\//i.test(attrValue)
          ) {
            const sanitized = sanitizeLinkedinUrl(attrValue);
            if (sanitized) return sanitized;
          }
        }
      }
      if (node.dataset) {
        for (const value of Object.values(node.dataset)) {
          if (value && /linkedin\.com\/in\//i.test(value)) {
            const sanitized = sanitizeLinkedinUrl(value);
            if (sanitized) return sanitized;
          }
        }
      }
      if (node.tagName === "A") {
        const href = node.getAttribute("href");
        if (href && /linkedin\.com\/in\//i.test(href)) {
          return sanitizeLinkedinUrl(href);
        }
      }
      queue.push(...Array.from(node.children || []));
    }
    return "";
  };
  const recruiterProfileHtmlCache = new Map();
  const fetchRecruiterProfileHtml = async (url) => {
    if (!url) return "";
    if (recruiterProfileHtmlCache.has(url)) {
      return recruiterProfileHtmlCache.get(url);
    }
    try {
      await wait(randomBetween(160, 280));
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) {
        recruiterProfileHtmlCache.set(url, "");
        return "";
      }
      const text = await response.text();
      recruiterProfileHtmlCache.set(url, text || "");
      return text || "";
    } catch (err) {
      console.warn("[Focals] recruiter profile fetch failed", err);
      recruiterProfileHtmlCache.set(url, "");
      return "";
    }
  };
  const extractPublicProfileFromHtml = (html) => {
    if (!html) return "";
    const match = html.match(/"publicProfileUrl":"(https:\/\/[^"]+)"/i);
    if (match) {
      return sanitizeLinkedinUrl(decodeJsonString(match[1]));
    }
    const linkMatch = html.match(/https:\/\/www\.linkedin\.com\/in\/[^"'\s<]+/i);
    if (linkMatch) {
      return sanitizeLinkedinUrl(linkMatch[0]);
    }
    return "";
  };
  const requestPublicProfileViaBackground = async (
    recruiterProfileUrl,
    name,
    requestId
  ) => {
    if (!recruiterProfileUrl) return "";
    try {
      await wait(randomBetween(140, 260));
      const response = await sendRuntimeMessage({
        type: "RESOLVE_RECRUITER_PUBLIC_URL",
        url: recruiterProfileUrl,
        name,
        requestId,
      });
      if (response && response.url) {
        return sanitizeLinkedinUrl(response.url);
      }
    } catch (err) {
      console.warn("[Focals] background public URL lookup failed", err);
    }
    return "";
  };
  const resolvePublicProfileUrl = async (
    article,
    name,
    recruiterProfileUrl,
    options = {}
  ) => {
    const { requestId } = options;
    const direct = findPublicProfileUrlInTree(article);
    if (direct) {
      return direct;
    }

    const key = normalizeNameKey(name);
    const index = buildPublicProfileIndex();
    const urls = key ? index.get(key) : null;
    if (urls && urls.length) {
      if (urls.length === 1) {
        return sanitizeLinkedinUrl(urls[0]);
      }
      const slug = slugifyName(name);
      if (slug) {
        const matchUrl = urls.find((url) => url.toLowerCase().includes(slug));
        if (matchUrl) {
          return sanitizeLinkedinUrl(matchUrl);
        }
      }
      return sanitizeLinkedinUrl(urls[0]);
    }

    if (recruiterProfileUrl) {
      const recruiterIdMatch = recruiterProfileUrl.match(/profile\/([^/?]+)/i);
      if (recruiterIdMatch) {
        const recruiterId = recruiterIdMatch[1];
        const html = document.documentElement.innerHTML || "";
        const pattern = new RegExp(
          `${recruiterId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^}]*?"publicProfileUrl":"(https:\/\/[^"]+)"`,
          "i"
        );
        const match = html.match(pattern);
        if (match) {
          return sanitizeLinkedinUrl(decodeJsonString(match[1]));
        }

        const fetchedHtml = await fetchRecruiterProfileHtml(recruiterProfileUrl);
        const fromHtml = extractPublicProfileFromHtml(fetchedHtml);
        if (fromHtml) {
          return fromHtml;
        }
      }
    }

    const viaBackground = await requestPublicProfileViaBackground(
      recruiterProfileUrl,
      name,
      requestId
    );
    if (viaBackground) {
      return viaBackground;
    }

    return "";
  };
  const getScrollElement = () => document.scrollingElement || document.documentElement || document.body;
  const gentleScrollTo = async (targetY) => {
    const scrollElement = getScrollElement();
    const startY = scrollElement.scrollTop;
    const distance = targetY - startY;
    if (Math.abs(distance) < 5) {
      return;
    }
    const steps = Math.max(3, Math.min(14, Math.round(Math.abs(distance) / 250)));
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
      scrollElement.scrollTop = startY + distance * eased;
      await wait(randomBetween(45, 95));
    }
  };
  const gentleScrollIntoView = async (element) => {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const targetY = getScrollElement().scrollTop + rect.bottom - window.innerHeight * 0.2;
    await gentleScrollTo(Math.max(0, targetY));
  };
  const ensurePipelineProfilesLoaded = async (targetCount = 25) => {
    const scrollElement = getScrollElement();
    let attempts = 0;
    let unchanged = 0;
    let previousCount = 0;
    while (attempts < 60) {
      const articles = document.querySelectorAll("article.profile-list-item");
      if (articles.length >= targetCount) {
        break;
      }
      const lastArticle = articles[articles.length - 1];
      if (lastArticle) {
        await gentleScrollIntoView(lastArticle);
      } else {
        await gentleScrollTo(scrollElement.scrollTop + window.innerHeight * 0.8);
      }
      await wait(randomBetween(120, 240));
      const newCount = document.querySelectorAll("article.profile-list-item").length;
      if (newCount === previousCount) {
        unchanged += 1;
      } else {
        unchanged = 0;
        previousCount = newCount;
      }
      if (unchanged >= 4) {
        break;
      }
      attempts += 1;
    }
    await wait(randomBetween(160, 260));
  };
  const toCsvValue = (value) => {
    if (value === null || value === undefined) {
      return "";
    }
    const normalized = normalizeText(String(value).replace(/\r?\n|\r/g, " "));
    if (!normalized) {
      return "";
    }
    const escaped = normalized.replace(/"/g, '""');
    return /[",\n]/.test(normalized) ? `"${escaped}"` : escaped;
  };
  const isPipelineListPage = () =>
    !!(
      document.querySelector("[data-test-paginated-list-item]") &&
      document.querySelector("article.profile-list-item")
    );
  const isRecruiterProfile = () => {
    if (isPipelineListPage()) {
      return false;
    }
    if (/linkedin\.com\/(talent|recruiter)/i.test(location.href)) {
      return true;
    }
    return !!(
      document.querySelector("[data-test-row-lockup-full-name]") ||
      document.querySelector("[data-test-profile-background-card] .experience-card")
    );
  };
  const createEmptyPipelineProfile = () => ({
    name: "—",
    current_title: "—",
    current_company: "—",
    contract: "—",
    localisation: "—",
    linkedin_url: "—",
    photo_url: "",
    firstName: "",
    lastName: "",
    connection_status: "unknown",
    connection_degree: "",
    connection_label: "",
    connection_summary: "",
    is_premium: false,
    can_message_without_connect: false,
  });
  const composeConnectionSummary = (profile) => {
    if (!profile) return "";
    const parts = [];
    if (profile.connection_status === "connected") {
      parts.push("Connecté");
    } else if (profile.connection_status === "not_connected") {
      parts.push("Non connecté");
    }
    if (profile.connection_degree) {
      parts.push(profile.connection_degree);
    } else if (
      profile.connection_label &&
      (!parts.length || parts[parts.length - 1] !== profile.connection_label)
    ) {
      parts.push(profile.connection_label);
    }
    if (profile.can_message_without_connect && profile.connection_status !== "connected") {
      parts.push("Message direct possible");
    }
    return normalizeText(parts.join(" · "));
  };
  const inferCompanyFromHeadline = (headline) => {
    if (!headline) return "";
    const match = headline.match(/(?:chez|at)\s+(.+)/i);
    if (match) {
      return normalizeText(match[1]);
    }
    const parts = headline.split("·").map((part) => normalizeText(part));
    if (parts.length >= 2) {
      return parts[1];
    }
    return "";
  };
  const buildPipelineEntry = async (article, options = {}) => {
    const { requestId, index = 0, total = 25 } = options;
    const profile = createEmptyPipelineProfile();

    const name = normalizeText(
      firstNonEmpty(
        pickTextFrom(article, ["[data-test-row-lockup-full-name] .artdeco-entity-lockup__title a"]),
        pickTextFrom(article, ["[data-test-row-lockup-full-name] a"]),
        pickTextFrom(article, ["[data-test-row-lockup-full-name]"]),
        pickTextFrom(article, [".artdeco-entity-lockup__title a"]),
        pickTextFrom(article, [".artdeco-entity-lockup__title"])
      )
    );
    if (name) {
      profile.name = name;
      if (name !== "—") {
        const [first, ...rest] = name.split(/\s+/);
        profile.firstName = first || "";
        profile.lastName = normalizeText(rest.join(" "));
      }
    }

    const recruiterLink =
      article.querySelector("a[data-test-link-to-profile-link]") ||
      article.querySelector("a[data-live-test-link-to-profile-link]");
    const recruiterProfileUrl = recruiterLink ? recruiterLink.href : "";
    pipelineProgress(requestId, {
      stage: "public-url",
      completed: index,
      total,
      hint: "lookup",
    });
    const publicProfileUrl = await resolvePublicProfileUrl(
      article,
      name,
      recruiterProfileUrl,
      options
    );
    if (publicProfileUrl) {
      profile.linkedin_url = publicProfileUrl;
    }

    const photoUrl =
      pickAttrFrom(article, [".artdeco-entity-lockup__image img"], "src") ||
      pickAttr([".artdeco-entity-lockup__image img"], "src");
    if (photoUrl) {
      profile.photo_url = photoUrl;
    }

    profile.is_premium = !!(
      article.querySelector("svg[data-test-icon*='linkedin-bug-premium']") ||
      article.querySelector("li-icon[type*='linkedin-bug-premium']") ||
      article.querySelector(".pv-member-badge--for-top-card")
    );

    const headline = normalizeText(pickTextFrom(article, ["[data-test-row-lockup-headline]"]));
    const location = cleanMetadataValue(
      firstNonEmpty(
        pickTextFrom(article, ["[data-test-row-lockup-location]"]),
        pickTextFrom(article, ["[data-test-row-lockup-location] span"])
      )
    );
    if (location) {
      profile.localisation = location;
    }

    const experienceSummary = findHistorySummary(article, /expérience/i);
    const roleInfo = parseRoleAndCompanyFromSummary(experienceSummary);
    const companyDetails = parseCompanyAndContract(experienceSummary);
    const resolvedRole = firstNonEmpty(roleInfo.role, headline);
    if (resolvedRole) {
      profile.current_title = resolvedRole;
    }
    const resolvedCompany = firstNonEmpty(
      roleInfo.company,
      companyDetails.company,
      inferCompanyFromHeadline(headline)
    );
    if (resolvedCompany) {
      profile.current_company = resolvedCompany;
    }
    if (companyDetails.contract) {
      profile.contract = companyDetails.contract;
    }

    const accessibleLabel = normalizeText(
      pickTextFrom(article, ["[data-test-lockup-degree] .a11y-text"])
    );
    const degreeVisible = normalizeText(
      pickTextFrom(article, ["[data-test-lockup-degree] .artdeco-entity-lockup__degree"])
    ).replace(/^·\s*/, "");
    const parsedDegree = parseConnectionDegree(`${degreeVisible} ${accessibleLabel}`);
    if (parsedDegree.degree) {
      profile.connection_degree = parsedDegree.degree;
    } else if (degreeVisible) {
      profile.connection_degree = degreeVisible;
    }
    if (parsedDegree.status && parsedDegree.status !== "unknown") {
      profile.connection_status = parsedDegree.status;
    }
    if (accessibleLabel) {
      profile.connection_label = accessibleLabel;
    }

    const actionButtons = Array.from(article.querySelectorAll("button"));
    const actionTexts = actionButtons
      .map((btn) => normalizeText(btn ? btn.innerText || btn.textContent : ""))
      .filter(Boolean);
    const lowerActionTexts = actionTexts.map((text) => text.toLowerCase());
    const hasMessageButton = lowerActionTexts.some((text) =>
      /message|messagerie|inmail|envoyer un message|send message/.test(text)
    );
    const hasConnectButton = lowerActionTexts.some((text) =>
      /se connecter|connect|conectar|connettersi/.test(text)
    );
    const hasFollowButton = lowerActionTexts.some((text) => /suivre|follow/.test(text));

    if (profile.connection_status === "unknown") {
      if (hasConnectButton || hasFollowButton) {
        profile.connection_status = "not_connected";
      } else if (hasMessageButton) {
        profile.connection_status = "connected";
      }
    }

    if (hasMessageButton && profile.connection_status !== "connected") {
      profile.can_message_without_connect = true;
    }

    profile.connection_summary = composeConnectionSummary(profile);

    return profile;
  };
  const scrapeRecruiterPipeline = async (options = {}) => {
    const { requestId, expectedTotal = 25 } = options;
    const scrollElement = getScrollElement();
    const initialScrollTop = scrollElement.scrollTop;
    pipelineProgress(requestId, {
      stage: "prepare",
      completed: 0,
      total: expectedTotal,
    });
    await ensurePipelineProfilesLoaded(expectedTotal);
    const articles = Array.from(document.querySelectorAll("article.profile-list-item"));
    if (!articles.length) {
      return { entries: [], csv: "", headers: [], count: 0 };
    }

    if (scrollElement.scrollTop !== initialScrollTop) {
      await gentleScrollTo(initialScrollTop);
      await wait(randomBetween(90, 160));
    }

    const limitedArticles = articles.slice(0, expectedTotal);
    const entries = [];
    const total = limitedArticles.length;
    pipelineProgress(requestId, {
      stage: "collect",
      completed: 0,
      total,
    });
    for (let index = 0; index < total; index += 1) {
      const article = limitedArticles[index];
      pipelineProgress(requestId, {
        stage: "profile",
        completed: index,
        total,
      });
      await wait(randomBetween(110, 190));
      entries.push(
        await buildPipelineEntry(article, {
          requestId,
          index,
          total,
        })
      );
      pipelineProgress(requestId, {
        stage: "profile",
        completed: index + 1,
        total,
      });
    }

    const headers = [
      { key: "name", label: "Name" },
      { key: "current_title", label: "Current title" },
      { key: "current_company", label: "Current company" },
      { key: "contract", label: "Contract" },
      { key: "localisation", label: "Location" },
      { key: "linkedin_url", label: "LinkedIn URL" },
      { key: "photo_url", label: "Photo URL" },
      { key: "firstName", label: "First name" },
      { key: "lastName", label: "Last name" },
      { key: "connection_status", label: "Connection status" },
      { key: "connection_degree", label: "Connection degree" },
      { key: "connection_label", label: "Connection label" },
      { key: "connection_summary", label: "Connection summary" },
      { key: "is_premium", label: "Premium" },
      { key: "can_message_without_connect", label: "Can message without connect" },
    ];

    pipelineProgress(requestId, {
      stage: "finalize",
      completed: total,
      total,
    });

    const csvLines = [headers.map((h) => toCsvValue(h.label)).join(",")];
    for (const entry of entries) {
      const row = headers.map((h) => toCsvValue(entry[h.key]));
      csvLines.push(row.join(","));
    }

    return {
      entries,
      headers,
      csv: csvLines.join("\r\n"),
      count: entries.length,
    };
  };
  const findRecruiterExperienceCard = () =>
    document.querySelector("[data-test-profile-background-card] .experience-card") ||
    document.querySelector(".experience-card");
  const extractRecruiterGroupExperience = (container) => {
    if (!container) return { role: "", company: "", contract: "" };
    const companyRaw = pickTextFrom(container, [
      "[data-test-grouped-position-entity-company-name]",
      ".grouped-position-entity__company-name",
      "strong.grouped-position-entity__company-name",
    ]);
    const parsedCompany = parseCompanyAndContract(companyRaw);
    const metadataNodes = Array.from(
      container.querySelectorAll("[data-test-grouped-position-entity-metadata-container]")
    );
    for (const metaNode of metadataNodes) {
      const roleText = pickTextFrom(metaNode, [
        "[data-test-grouped-position-entity-title] a",
        "[data-test-grouped-position-entity-title]",
        ".position-item__position-title-link",
        ".t-16",
      ]);
      const normalizedRole = normalizeText(roleText);
      if (!normalizedRole) {
        continue;
      }

      const companyCandidate = firstNonEmpty(
        pickTextFrom(metaNode, [
          "[data-test-position-entity-company-name]",
          ".position-item__company-link",
        ]),
        parsedCompany.company,
        companyRaw
      );
      const parsedCandidate = parseCompanyAndContract(companyCandidate);
      const contractHint = firstNonEmpty(
        pickTextFrom(metaNode, ["[data-test-position-entity-employment-status]"]),
        parsedCandidate.contract,
        parsedCompany.contract,
        detectContract(metaNode ? metaNode.innerText : "")
      );

      return {
        role: normalizedRole,
        company: firstNonEmpty(parsedCandidate.company, companyCandidate, parsedCompany.company, companyRaw),
        contract: firstNonEmpty(detectContract(contractHint), contractHint),
      };
    }

    return {
      role: "",
      company: parsedCompany.company || companyRaw || "",
      contract: parsedCompany.contract || "",
    };
  };
  const extractRecruiterSingleExperience = (container) => {
    if (!container) return { role: "", company: "", contract: "" };
    const roleText = pickTextFrom(container, [
      "[data-test-position-entity-title]",
      ".position-item__position-title-link",
      ".background-entity__summary-definition--title",
      ".t-16",
    ]);
    const normalizedRole = normalizeText(roleText);
    if (!normalizedRole) {
      return { role: "", company: "", contract: "" };
    }

    const companyRaw = firstNonEmpty(
      pickTextFrom(container, [
        "[data-test-position-entity-company-name]",
        ".position-item__company-link",
        ".background-entity__summary-definition--subtitle",
      ]),
      pickTextFrom(container, [".background-entity__summary-definition--title a"])
    );
    const parsedCompany = parseCompanyAndContract(companyRaw);
    const contractHint = firstNonEmpty(
      pickTextFrom(container, ["[data-test-position-entity-employment-status]"]),
      parsedCompany.contract,
      detectContract(container ? container.innerText : ""),
      detectContract(companyRaw)
    );

    return {
      role: normalizedRole,
      company: parsedCompany.company || companyRaw || "",
      contract: firstNonEmpty(detectContract(contractHint), contractHint),
    };
  };
  const extractRecruiterExperience = (experienceCard) => {
    if (!experienceCard) {
      return { role: "", company: "", contract: "" };
    }
    const containers = Array.from(
      experienceCard.querySelectorAll("[data-test-group-position-list-container], [data-test-position-list-container]")
    );
    for (const container of containers) {
      const data = container.hasAttribute("data-test-group-position-list-container")
        ? extractRecruiterGroupExperience(container)
        : extractRecruiterSingleExperience(container);
      if (data.role || data.company) {
        return data;
      }
    }
    return { role: "", company: "", contract: "" };
  };
  const findExperienceSection = () => {
    const anchor = q("#experience");
    if (anchor) {
      const section = anchor.closest("section");
      if (section) {
        return section;
      }
    }
    const cards = Array.from(document.querySelectorAll("section.artdeco-card"));
    for (const card of cards) {
      const heading = pickTextFrom(card, ["h2 span[aria-hidden='true']", "h2"]);
      if (heading && /expérience/i.test(heading)) {
        return card;
      }
    }
    return null;
  };

  // === Listener ===
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "FOCALS_PING") {
      sendResponse({ ok: true });
    } else if (msg?.type === "GET_CANDIDATE_DATA") {
      try {
        const data = scrapePublicProfile();
        console.log("[Focals] Scraped data:", data);
        sendResponse({ data });
      } catch (e) {
        console.error("[Focals] scrape error", e);
        sendResponse({ error: e.message });
      }
    } else if (msg?.type === "GET_PIPELINE_DATA") {
      (async () => {
        try {
          const result = await scrapeRecruiterPipeline();
          if (!result.entries.length) {
            sendResponse({ error: "Aucun profil de pipeline détecté sur cette page." });
            return;
          }
          console.log("[Focals] Pipeline export:", result.entries.length, "profils");
          sendResponse({ data: result });
        } catch (e) {
          console.error("[Focals] pipeline export error", e);
          sendResponse({ error: e.message });
        }
      })();
      return true;
    } else if (msg?.type === "PIPELINE_EXPORT_START") {
      const { requestId, expectedTotal } = msg || {};
      (async () => {
        try {
          const result = await scrapeRecruiterPipeline({
            requestId,
            expectedTotal: typeof expectedTotal === "number" ? expectedTotal : 25,
          });
          if (!result.entries.length) {
            await sendRuntimeMessage({
              type: "PIPELINE_EXPORT_ERROR",
              requestId,
              error: "Aucun profil de pipeline détecté sur cette page.",
            });
            return;
          }
          await sendRuntimeMessage({
            type: "PIPELINE_EXPORT_COMPLETE",
            requestId,
            csv: result.csv,
            count: result.count,
          });
        } catch (e) {
          console.error("[Focals] pipeline export error", e);
          await sendRuntimeMessage({
            type: "PIPELINE_EXPORT_ERROR",
            requestId,
            error: e?.message || "Erreur inconnue pendant l'export pipeline.",
          });
        }
      })();
      sendResponse({ ok: true });
      return;
    } else if (msg?.type === "PIPELINE_DOWNLOAD_CSV") {
      (async () => {
        try {
          const filename = msg.filename || "pipeline.csv";
          const csv = typeof msg.csv === "string" ? msg.csv : "";
          if (!csv) {
            throw new Error("CSV vide");
          }

          const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = filename;
          anchor.style.display = "none";
          document.body.appendChild(anchor);
          anchor.click();
          setTimeout(() => {
            anchor.remove();
            URL.revokeObjectURL(url);
          }, 1500);

          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ error: e?.message || "" });
        }
      })();
      return true;
    } else if (msg?.type === "GET_PUBLIC_PROFILE_URL") {
      (async () => {
        try {
          let url = findPublicProfileUrl();
          if (!url) {
            await wait(randomBetween(160, 260));
            url = findPublicProfileUrl();
          }

          let attempt = 0;
          const maxAttempts = 8;
          while (!url && attempt < maxAttempts) {
            attempt += 1;
            await openPublicProfileFlyout();
            await wait(randomBetween(180, 320));
            url = findPublicProfileUrl();
            if (!url) {
              url = findPublicProfileUrlInTree(document.body);
            }
          }

          if (!url) {
            url = findPublicProfileUrlInTree(document.body);
          }

          sendResponse({ url: url ? sanitizeLinkedinUrl(url) : "" });
        } catch (e) {
          sendResponse({ error: e?.message || "" });
        }
      })();
      return true;
    }
  });

  const scrapeRecruiterProfile = () => {
    const topCardWrapper =
      document.querySelector(".profile__topcard-wrapper") ||
      document.querySelector("[data-test-topcard-condensed-lockup]")?.closest(".profile__topcard-wrapper") ||
      document.querySelector("[data-test-profile-top-card]") ||
      document.body;

    const topCard =
      (topCardWrapper &&
        (topCardWrapper.querySelector("[data-test-topcard-condensed-lockup] .artdeco-entity-lockup__content") ||
          topCardWrapper.querySelector(".artdeco-entity-lockup__content"))) ||
      document.querySelector("[data-test-row-lockup-full-name]")?.closest(".artdeco-entity-lockup__content");

    const name = normalizeText(
      firstNonEmpty(
        pickTextFrom(topCard, ["[data-test-row-lockup-full-name] .artdeco-entity-lockup__title"]),
        pickTextFrom(topCard, ["[data-test-row-lockup-full-name]"]),
        pickTextFrom(topCardWrapper, ["[data-test-row-lockup-full-name] .artdeco-entity-lockup__title"]),
        pickTextFrom(topCardWrapper, ["[data-test-row-lockup-full-name]"]),
        pickTextFrom(topCardWrapper, [".artdeco-entity-lockup__title"]),
        pickText("[data-test-row-lockup-full-name]")
      )
    );

    const headline = firstNonEmpty(
      pickTextFrom(topCard, ["[data-test-row-lockup-headline]", ".artdeco-entity-lockup__subtitle"]),
      pickTextFrom(topCardWrapper, ["[data-test-row-lockup-headline]", ".artdeco-entity-lockup__subtitle"]),
      pickText("[data-test-row-lockup-headline]")
    );

    const localisation = cleanMetadataValue(
      firstNonEmpty(
        pickTextFrom(topCard, ["[data-test-row-lockup-location]"]),
        pickTextFrom(topCardWrapper, ["[data-test-row-lockup-location]"]),
        pickText("[data-test-row-lockup-location]")
      )
    );

    const photo_url =
      pickAttrFrom(
        topCardWrapper,
        [
          ".artdeco-entity-lockup__image img[data-test-avatar-image]",
          ".artdeco-entity-lockup__image img",
          "img[data-test-row-lockup-profile-image]",
          "img[data-test-avatar-image]",
        ],
        "src"
      ) ||
      pickAttr(
        [
          ".artdeco-entity-lockup__image img[data-test-avatar-image]",
          ".artdeco-entity-lockup__image img",
          "img[data-test-row-lockup-profile-image]",
          "img[data-test-avatar-image]",
        ],
        "src"
      ) ||
      "";

    const topCardCompanyRaw = firstNonEmpty(
      pickTextFrom(topCard, ["[data-test-topcard-condensed-lockup-current-employer]"]),
      pickTextFrom(topCardWrapper, ["[data-test-topcard-condensed-lockup-current-employer]"]),
      pickText("[data-test-topcard-condensed-lockup-current-employer]")
    );
    const topCardCompany = parseCompanyAndContract(topCardCompanyRaw);

    let current_title = headline || "";
    let current_company = topCardCompany.company;
    let contract = topCardCompany.contract;

    const experienceCard = findRecruiterExperienceCard();
    if (experienceCard) {
      const experience = extractRecruiterExperience(experienceCard);
      if (experience.role) {
        current_title = experience.role;
      }
      if (experience.company) {
        current_company = experience.company;
      }
      if (!contract && experience.contract) {
        contract = experience.contract;
      }
    }

    if (!contract) {
      contract = detectContract(current_company);
    }

    const [firstName, ...rest] = (name || "").split(/\s+/);
    const lastName = rest.join(" ").trim();

    const connectionInfo = computeConnectionInfo();
    const publicProfileUrl = sanitizeLinkedinUrl(findPublicProfileUrl());

    return {
      name: name || "—",
      current_title: current_title || headline || "—",
      current_company: current_company || "—",
      contract: contract || "—",
      localisation: localisation || "—",
      linkedin_url: publicProfileUrl || location.href || "—",
      photo_url,
      firstName,
      lastName,
      connection_status: connectionInfo.connection_status,
      connection_degree: connectionInfo.connection_degree,
      connection_label: connectionInfo.connection_label,
      connection_summary: connectionInfo.connection_summary,
      is_premium: connectionInfo.is_premium,
      can_message_without_connect: connectionInfo.can_message_without_connect,
    };
  };

  // === Scraper profil public /in/ ===
  function scrapePublicProfile() {
    if (isPipelineListPage()) {
      throw new Error("Cette page affiche une liste pipeline. Utilise l'export CSV.");
    }
    if (isRecruiterProfile()) {
      return scrapeRecruiterProfile();
    }
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
      pickAttr([
        "a[href*='/overlay/about-this-profile/']",
        "a[href*='overlay/about-this-profile']",
        "a[href*='/overlay/contact-info/']",
      ], "aria-label") ||
      "";
    const name = rawName.replace(/\s+/g, " ").trim();

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

    // On récupère la première expérience visible
    let current_title = headline || "";
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

    const experienceSection = findExperienceSection();
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
        const multiRoleItems = Array.from(
          firstEntity.querySelectorAll(".pvs-entity__sub-components ul li")
        );
        let roleNode = firstEntity;
        let multiRoleMatch = false;
        if (multiRoleItems.length) {
          for (const item of multiRoleItems) {
            if (item.querySelector(".pvs-thumbnail__wrapper")) {
              continue;
            }

            const anchorsWithDataField = item.querySelectorAll("a[data-field]");
            if (anchorsWithDataField.length) {
              let shouldSkip = false;
              for (const anchor of anchorsWithDataField) {
                const fieldName = anchor.getAttribute("data-field") || "";
                if (/skill/i.test(fieldName)) {
                  shouldSkip = true;
                  break;
                }
              }
              if (shouldSkip) {
                continue;
              }
            }

            const candidateText = pickRoleText(item);
            if (!candidateText) {
              continue;
            }

            roleNode = item;
            multiRoleMatch = roleNode !== firstEntity;
            break;
          }
        }

        const topLevelRoleText = pickRoleText(firstEntity);
        const roleText = pickRoleText(roleNode) || topLevelRoleText;
        if (roleText) {
          current_title = roleText;
        }

        const headerCompanyText =
          multiRoleMatch && topLevelRoleText && topLevelRoleText !== roleText ? topLevelRoleText : "";
        const parsedHeaderCompany = headerCompanyText ? parseCompanyAndContract(headerCompanyText) : { company: "", contract: "" };

        const companyCandidates = [];
        if (multiRoleMatch) {
          if (parsedHeaderCompany.company) {
            companyCandidates.push(parsedHeaderCompany.company);
          } else if (headerCompanyText) {
            companyCandidates.push(headerCompanyText);
          }

          const firstEntityCompany = pickCompanyText(firstEntity);
          if (firstEntityCompany) {
            companyCandidates.push(firstEntityCompany);
          }

          let roleCompany = "";
          if (roleNode && roleNode.querySelector("a[data-field='experience_company_logo']")) {
            roleCompany = pickCompanyText(roleNode);
          }
          if (roleCompany) {
            companyCandidates.push(roleCompany);
          }
        } else {
          companyCandidates.push(pickCompanyText(firstEntity));
          if (roleNode !== firstEntity) {
            companyCandidates.push(pickCompanyText(roleNode));
          }
        }

        let companyText = firstNonEmpty(...companyCandidates);
        let parsedCompany = parseCompanyAndContract(companyText);

        if (!parsedCompany.company && parsedHeaderCompany.company) {
          parsedCompany = parsedHeaderCompany;
          if (!companyText) {
            companyText = parsedHeaderCompany.company;
          }
        }

        if (parsedCompany.company) {
          current_company = parsedCompany.company;
        } else if (companyText) {
          current_company = companyText;
        }

        const contractHints = [
          parsedCompany.contract,
          parsedHeaderCompany.contract,
          companyText ? detectContract(companyText) : "",
          multiRoleMatch && topLevelRoleText ? detectContract(topLevelRoleText) : "",
          detectContract(roleNode ? roleNode.innerText : ""),
          detectContract(firstEntity.innerText || ""),
        ];

        for (const hint of contractHints) {
          if (!contract && hint) {
            contract = hint;
            break;
          }
        }
      }
    }

    if (!contract) {
      contract = detectContract(current_company);
    }

    // Nettoyage
    const [firstName, ...rest] = (name || "").split(/\s+/);
    const lastName = rest.join(" ").trim();

    const connectionInfo = computeConnectionInfo();
    const publicProfileUrl = sanitizeLinkedinUrl(findPublicProfileUrl());

    return {
      name: name || "—",
      current_title: current_title || headline || "—",
      current_company: current_company || "—",
      contract: contract || "—",
      localisation: localisation || "—",
      linkedin_url: publicProfileUrl || location.href || "—",
      photo_url: photo_url || "",
      firstName,
      lastName,
      connection_status: connectionInfo.connection_status,
      connection_degree: connectionInfo.connection_degree,
      connection_label: connectionInfo.connection_label,
      connection_summary: connectionInfo.connection_summary,
      is_premium: connectionInfo.is_premium,
      can_message_without_connect: connectionInfo.can_message_without_connect,
    };
  }
})();

