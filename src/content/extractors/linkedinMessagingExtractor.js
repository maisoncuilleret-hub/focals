const DEFAULT_DAY_LABELS = [
  "AUJOURD'HUI",
  "HIER",
  "LUNDI",
  "MARDI",
  "MERCREDI",
  "JEUDI",
  "VENDREDI",
  "SAMEDI",
  "DIMANCHE",
  "TODAY",
  "YESTERDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

const WEEKDAY_INDEX = {
  DIMANCHE: 0,
  SUNDAY: 0,
  LUNDI: 1,
  MONDAY: 1,
  MARDI: 2,
  TUESDAY: 2,
  MERCREDI: 3,
  WEDNESDAY: 3,
  JEUDI: 4,
  THURSDAY: 4,
  VENDREDI: 5,
  FRIDAY: 5,
  SAMEDI: 6,
  SATURDAY: 6,
};

const pad2 = (value) => String(value).padStart(2, "0");

const norm = (text = "") =>
  text
    .replace(/\u00a0/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const cleanUrl = (url) => {
  if (!url) return null;
  try {
    const prefixed = url.startsWith("http")
      ? url
      : url.startsWith("/")
        ? `https://www.linkedin.com${url}`
        : `https://www.linkedin.com/${url}`;
    const parsed = new URL(prefixed);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch (err) {
    return null;
  }
};

const isTechnicalLinkedinUrl = (url) => /ACoA/i.test(url || "");

const idFromInUrl = (href) => {
  if (!href) return null;
  const match = href.match(/linkedin\.com\/in\/([^/?#]+)/i) ||
    href.match(/\/in\/([^/?#]+)/i);
  return match?.[1] || null;
};

const urnFromId = (id) => (id ? `urn:li:fsd_profile:${id}` : null);

const detectDayLabel = (text) => {
  const cleaned = norm(text || "").toUpperCase();
  if (!cleaned) return null;
  for (const label of DEFAULT_DAY_LABELS) {
    if (cleaned.includes(label)) return label;
  }
  return null;
};

const getCandidateHeader = (root) => {
  const doc = root?.ownerDocument || document;

  const anchor =
    doc.querySelector(".msg-thread__link-to-profile") ||
    doc.querySelector(".msg-entity-lockup__entity-link") ||
    doc.querySelector("a[href*='/in/']");

  if (!anchor) return { fullName: null, linkedinPublicUrl: null };

  const rawHref = anchor.getAttribute("href");
  const linkedinPublicUrl = cleanUrl(rawHref);

  let fullName = anchor.textContent || "";
  fullName = fullName.split("\n")[0].trim();

  return { fullName, linkedinPublicUrl };
};

const findDayLabelInNode = (node) => {
  if (!node) return null;
  const labelNode =
    node.querySelector?.(
      ".msg-s-message-list__date, .msg-s-event-listitem__date, time"
    ) || null;
  const labelText = norm(labelNode?.textContent || "");
  if (labelText) {
    const detected = detectDayLabel(labelText);
    if (detected) return detected;
  }

  const fallbackText = norm(node.textContent || "");
  const fallbackLabel = detectDayLabel(fallbackText);
  if (fallbackLabel && fallbackText.length <= 24) return fallbackLabel;
  return null;
};

const getDayByUrn = (root) => {
  const map = new Map();
  if (!root?.querySelectorAll) return map;
  const list =
    root.querySelector("ul.msg-s-message-list-content") ||
    root.querySelector("ul.msg-s-message-list__event-list") ||
    root.querySelector("ul.msg-s-message-list");
  const container = list || root;
  const children = Array.from(container.children || []);
  let currentLabel = null;

  children.forEach((child) => {
    const label = findDayLabelInNode(child);
    if (label) currentLabel = label;
    const messageNodes = child.matches?.(
      "div.msg-s-event-listitem[data-event-urn]"
    )
      ? [child]
      : Array.from(
          child.querySelectorAll?.(
            "div.msg-s-event-listitem[data-event-urn]"
          ) || []
        );
    messageNodes.forEach((node) => {
      const urn = node.getAttribute("data-event-urn") || "";
      if (urn) map.set(urn, currentLabel || null);
    });
  });

  if (!map.size) {
    const nodes = root.querySelectorAll("div.msg-s-event-listitem[data-event-urn]");
    nodes.forEach((node) => {
      const urn = node.getAttribute("data-event-urn") || "";
      if (urn) map.set(urn, null);
    });
  }

  return map;
};

const getProfileHrefFromItem = (item) => {
  if (!item?.querySelector) return null;
  const selectors = [
    "a.msg-s-event-listitem__link[href*='/in/']",
    ".msg-s-message-group__meta a[href*='/in/']",
    "a[href*='/in/']",
  ];
  for (const selector of selectors) {
    const anchor = item.querySelector(selector);
    const href = anchor?.getAttribute("href");
    if (href) return href;
  }
  return null;
};

const parseTimeText = (text) => {
  if (!text) return null;
  const cleaned = norm(text).toLowerCase();
  const match = cleaned.match(/(\d{1,2})[:h](\d{2})/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const isPm = /\bpm\b/.test(cleaned);
  const isAm = /\bam\b/.test(cleaned);
  if (isPm && hours < 12) hours += 12;
  if (isAm && hours === 12) hours = 0;
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  if (hours > 23 || minutes > 59) return null;
  return `${pad2(hours)}:${pad2(minutes)}`;
};

const getHHMM = (item) => {
  if (!item) return null;
  const candidates = [];
  const titleNode = item.querySelector(
    "span.msg-s-event-with-indicator__sending-indicator[title]"
  );
  if (titleNode?.getAttribute("title")) {
    candidates.push(titleNode.getAttribute("title"));
  }
  item.querySelectorAll("time, .msg-s-message-group__timestamp").forEach((node) => {
    candidates.push(node.getAttribute("datetime") || node.textContent || "");
  });

  const group = item.closest(".msg-s-message-group") || item.closest("li");
  if (group) {
    group
      .querySelectorAll("time, .msg-s-message-group__timestamp")
      .forEach((node) => {
        candidates.push(node.getAttribute("datetime") || node.textContent || "");
      });
  }

  candidates.push(item.textContent || "");
  if (group && group !== item) candidates.push(group.textContent || "");

  for (const candidate of candidates) {
    const hhmm = parseTimeText(candidate);
    if (hhmm) return hhmm;
  }
  return null;
};

const isJunkLine = (line) => {
  if (!line) return true;
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^Voir le profil/i.test(trimmed)) return true;
  if (/^Répondez à la conversation/i.test(trimmed)) return true;
  if (/a envoyé le message/i.test(trimmed)) return true;
  if (/a envoyé les messages/i.test(trimmed)) return true;
  if (detectDayLabel(trimmed)) return true;
  return false;
};

const extractText = (item) => {
  if (!item) return null;
  const bubble =
    item.querySelector(".msg-s-event-listitem__message-bubble") ||
    item.querySelector("p.msg-s-event-listitem__body") ||
    item.querySelector(".msg-s-event-listitem__body") ||
    item;
  const rawText = bubble?.innerText || bubble?.textContent || "";
  if (!rawText) return null;
  const normalized = norm(rawText);
  if (!normalized) return null;
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !isJunkLine(line));
  const cleaned = norm(lines.join("\n"));
  if (!cleaned || cleaned.length < 2) return null;
  return cleaned.replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
};

const dateForLabel = (label) => {
  if (!label) return null;
  const upper = label.toUpperCase();
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (upper.includes("AUJOURD'HUI") || upper.includes("TODAY")) return base;
  if (upper.includes("HIER") || upper.includes("YESTERDAY")) {
    base.setDate(base.getDate() - 1);
    return base;
  }
  const targetDay = WEEKDAY_INDEX[upper];
  if (targetDay === undefined) return base;
  const todayIndex = base.getDay();
  const diff = (todayIndex - targetDay + 7) % 7;
  base.setDate(base.getDate() - diff);
  return base;
};

const toLocalIso = (baseDate, hhmm) => {
  if (!baseDate || !hhmm) return null;
  const [hourStr, minuteStr] = hhmm.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  const date = new Date(baseDate);
  date.setHours(hour, minute, 0, 0);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate()
  )}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:00${offset}`;
};

const whoFactory = (candidateTechnicalUrl, myTechnicalUrl, candidateName) => {
  const candidateId = idFromInUrl(candidateTechnicalUrl);
  const myId = idFromInUrl(myTechnicalUrl);
  const candidateNameLower = candidateName?.toLowerCase() || null;

  return (item) => {
    const container = item?.closest?.(".msg-s-event-listitem") || item;
    if (container?.classList?.contains("msg-s-event-listitem--self")) return "me";
    if (container?.classList?.contains("msg-s-event-listitem--other"))
      return "candidate";

    const href = cleanUrl(getProfileHrefFromItem(container));
    if (href) {
      if (candidateTechnicalUrl && href === candidateTechnicalUrl) return "candidate";
      if (myTechnicalUrl && href === myTechnicalUrl) return "me";
      return "me";
    }

    const eventUrn = container?.getAttribute?.("data-event-urn") || "";
    if (candidateId && eventUrn.includes(candidateId)) return "candidate";
    if (myId && eventUrn.includes(myId)) return "me";

    const ariaLabel =
      container?.getAttribute?.("aria-label") ||
      container?.querySelector?.("[aria-label]")?.getAttribute?.("aria-label") ||
      "";
    const match =
      ariaLabel.match(/Options pour le message de\s+(.+)/i) ||
      ariaLabel.match(/Message options for\s+(.+)/i);
    if (match?.[1]) {
      const name = norm(match[1]);
      if (candidateNameLower && name.toLowerCase().includes(candidateNameLower))
        return "candidate";
      return "me";
    }

    return "unknown";
  };
};

export const extractLinkedinConversation = (root, options = {}) => {
  const warnings = [];
  const log = typeof options.logger === "function" ? options.logger : () => {};
  const fillMissingTime = options.fillMissingTime !== false;
  const href = options.href || (typeof window !== "undefined" ? window.location.href : null);
  const extractedAtIso = new Date().toISOString();

  if (!root) {
    warnings.push({ code: "NO_ROOT" });
    return {
      candidate: {
        fullName: null,
        linkedinPublicUrl: null,
        linkedinTechnicalUrl: null,
        linkedinProfileUrn: null,
        linkedinIdSegment: null,
      },
      me: {
        linkedinTechnicalUrl: null,
        linkedinProfileUrn: null,
        linkedinIdSegment: null,
      },
      messages: [],
      warnings,
      meta: { extractedAtIso, href },
    };
  }

  const header = getCandidateHeader(root);
  const items = Array.from(
    root.querySelectorAll("div.msg-s-event-listitem[data-event-urn]")
  );
  const uniqHrefs = Array.from(
    new Set(
      items
        .map((item) => cleanUrl(getProfileHrefFromItem(item)))
        .filter(Boolean)
    )
  );

  let candidateTechnicalUrl = null;
  let myTechnicalUrl = null;
  const headerUrl = header.linkedinPublicUrl
    ? cleanUrl(header.linkedinPublicUrl)
    : null;
  const technicalHrefs = uniqHrefs.filter((link) => isTechnicalLinkedinUrl(link));
  if (uniqHrefs.length >= 2) {
    if (technicalHrefs.length) {
      candidateTechnicalUrl =
        (headerUrl && technicalHrefs.includes(headerUrl) && headerUrl) || technicalHrefs[0];
      myTechnicalUrl = uniqHrefs.find((href) => href !== candidateTechnicalUrl) || null;
    } else {
      candidateTechnicalUrl =
        (headerUrl && uniqHrefs.includes(headerUrl) && headerUrl) || uniqHrefs[0];
      myTechnicalUrl = uniqHrefs.find((href) => href !== candidateTechnicalUrl) || null;
    }
  } else if (uniqHrefs.length === 1) {
    candidateTechnicalUrl = technicalHrefs[0] || headerUrl || uniqHrefs[0];
    myTechnicalUrl = null;
    warnings.push({ code: "MISSING_MY_TECH_URL" });
  } else {
    candidateTechnicalUrl = headerUrl || null;
    myTechnicalUrl = null;
    warnings.push({ code: "MISSING_MY_TECH_URL" });
  }

  if (uniqHrefs.length > 2) {
    warnings.push({ code: "GROUP_CHAT_OR_EXTRA_ACTOR", detail: uniqHrefs });
  }

  log("header", header);
  log("uniqHrefs", uniqHrefs);

  const dayByUrn = getDayByUrn(root);
  const who = whoFactory(candidateTechnicalUrl, myTechnicalUrl, header.fullName);
  const messages = [];
  const lastTimeByLabel = new Map();
  const senderSet = new Set();

  items.forEach((item) => {
    const urn = item.getAttribute("data-event-urn") || null;
    const text = extractText(item);
    if (!text) return;
    const dayLabel = dayByUrn.get(urn) || null;
    let hhmm = getHHMM(item);
    const sender = who(item);
    let timeInferred = false;
    if (fillMissingTime && (!hhmm || hhmm === "")) {
      const fallback = dayLabel ? lastTimeByLabel.get(dayLabel) : null;
      if (fallback) {
        hhmm = fallback;
        timeInferred = true;
      } else {
        hhmm = null;
        timeInferred = true;
      }
    }

    if (dayLabel && hhmm) {
      lastTimeByLabel.set(dayLabel, hhmm);
    }

    const baseDate = dayLabel ? dateForLabel(dayLabel) : null;
    const sentAtIso = hhmm && baseDate ? toLocalIso(baseDate, hhmm) : null;

    if (sender) senderSet.add(sender);

    const message = {
      urn,
      sender,
      dayLabel,
      hhmm,
      sentAtIso,
      text,
    };

    if (timeInferred) message.timeInferred = true;

    messages.push(message);
  });

  if (!(senderSet.has("me") && senderSet.has("candidate"))) {
    warnings.push({ code: "SENDER_SPLIT_WEAK" });
  }

  const candidateId = idFromInUrl(candidateTechnicalUrl);
  const myId = idFromInUrl(myTechnicalUrl);
  const payload = {
    candidate: {
      fullName: header.fullName || null,
      linkedinPublicUrl: header.linkedinPublicUrl || null,
      linkedinTechnicalUrl:
        candidateTechnicalUrl || header.linkedinPublicUrl || null,
      linkedinProfileUrn: urnFromId(candidateId),
      linkedinIdSegment: candidateId,
    },
    me: {
      linkedinTechnicalUrl: myTechnicalUrl || null,
      linkedinProfileUrn: urnFromId(myId),
      linkedinIdSegment: myId,
    },
    messages,
    meta: { extractedAtIso, href },
  };

  if (warnings.length) payload.warnings = warnings;

  log("warnings", warnings);
  log("counts", {
    messages: messages.length,
    inferred: messages.filter((msg) => msg.timeInferred).length,
  });

  return payload;
};
