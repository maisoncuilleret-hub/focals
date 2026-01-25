const clean = (t) => (t ? String(t).replace(/\s+/g, " ").trim() : "");

const normalizeInfosText = (s) =>
  (s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const fixSpacedUrls = (t) => t.replace(/\bhttps?:\/\/[^\s)]+/gi, (url) => url.replace(/\s+/g, ""));

const monthTokenRegex =
  /(janv\.?|févr\.?|f[ée]v\.?|mars|avr\.?|mai|juin|juil\.?|ao[uû]t|sept\.?|oct\.?|nov\.?|d[ée]c\.?|jan|feb|mar|apr|may|jun|jul|aug|sep|septembre|october|november|dec|january|february|march|april|june|july|august|september|october|november|december)/i;

const looksLikeDateRange = (text) => {
  const t = clean(text).toLowerCase();
  if (!t) return false;
  if (/\b(19\d{2}|20\d{2})\b/.test(t) && (t.includes(" - ") || t.includes("–") || t.includes("—"))) {
    return true;
  }
  if (t.includes("aujourd") || t.includes("present") || t.includes("présent")) return true;
  if (monthTokenRegex.test(t) && /\b(19\d{2}|20\d{2})\b/.test(t)) return true;
  return false;
};

const isMostlyDatesText = (text) => {
  const t = clean(text).toLowerCase();
  if (!t) return false;
  if (t.length < 8) return false;
  if (!looksLikeDateRange(t)) return false;
  const stripped = t
    .replace(monthTokenRegex, "")
    .replace(/\b(19\d{2}|20\d{2})\b/g, "")
    .replace(/\b(aujourd'hui|aujourd’hui|present|présent)\b/g, "")
    .replace(/[0-9]/g, "")
    .replace(/[\s·\-–—]+/g, "")
    .trim();
  return stripped.length < 6;
};

const extractTextWithBreaks = (node) => {
  if (!node) return "";
  const html = node.innerHTML || "";
  const withBreaks = html.replace(/<br\s*\/?>/gi, "\n");
  return withBreaks.replace(/<[^>]*>/g, "");
};

const isDateRangeLine = (line) => /^(du|from)\b.+\b(au|to)\b/i.test(line);

const buildMetaLines = (ctx) => {
  const title = clean(ctx?.title || "");
  const company = clean(ctx?.company || "");
  const companyLine = clean(ctx?.companyLine || "");
  const dates = clean(ctx?.dates || "");
  const location = clean(ctx?.location || "");
  const workplaceType = clean(ctx?.workplaceType || "");
  const combo = [location, workplaceType].filter(Boolean).join(" · ");
  return [title, company, companyLine, dates, location, workplaceType, combo].filter(Boolean);
};

const isTrivialMetaDescription = (desc, ctx) => {
  if (!desc) return true;
  const normalized = clean(desc).toLowerCase();
  if (!normalized) return true;
  const metaLines = buildMetaLines(ctx).map((line) => line.toLowerCase());
  if (metaLines.some((line) => line && normalized === line)) return true;
  const title = clean(ctx?.title || "").toLowerCase();
  if (title && normalized === `${title} ${title}`.trim()) return true;
  if (isDateRangeLine(desc) || isMostlyDatesText(desc)) return true;
  return false;
};

const normalizeDetailsDescription = (text, ctx) => {
  let normalized = normalizeInfosText(text || "");
  normalized = normalized.replace(/…\s*(voir plus|see more|show more|afficher la suite)\s*$/i, "").trim();
  normalized = fixSpacedUrls(normalized);
  if (!normalized) return null;

  const metaLines = buildMetaLines(ctx).map((line) => line.toLowerCase());
  const lines = normalized
    .split("\n")
    .map((line) => line.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const filtered = [];
  let lastKey = null;
  for (const line of lines) {
    if (/comp[ée]tences\s*:/i.test(line)) continue;
    if (isDateRangeLine(line) || isMostlyDatesText(line)) continue;
    if (isTrivialMetaDescription(line, ctx)) continue;
    const key = line.toLowerCase();
    if (metaLines.some((meta) => meta && key === meta)) continue;
    if (lastKey && key === lastKey) continue;
    filtered.push(line);
    lastKey = key;
  }

  const finalText = filtered.join("\n").trim();
  if (!finalText || finalText.length < 20 || isTrivialMetaDescription(finalText, ctx)) return null;
  return finalText;
};

const extractDetailsDescription = (root, ctx) => {
  if (!root) return null;
  const scope = root.querySelector(".pvs-entity__sub-components") || root;
  const preferredNodes = Array.from(
    scope.querySelectorAll(
      'div[class*="inline-show-more-text"] span[aria-hidden="true"]:not(.visually-hidden), .pv-shared-text-with-see-more span[aria-hidden="true"]:not(.visually-hidden)'
    )
  );
  const inlineNodes = preferredNodes.length
    ? preferredNodes
    : Array.from(scope.querySelectorAll('div[class*="inline-show-more-text"], .pv-shared-text-with-see-more'));

  const inlineText = inlineNodes.map(extractTextWithBreaks).filter(Boolean).join("\n");
  return normalizeDetailsDescription(inlineText, ctx);
};

export { extractDetailsDescription };
