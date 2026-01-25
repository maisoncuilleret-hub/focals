const SKILLS_LABEL_RE = /Comp[ée]tences\s*:/i;
const MORE_RE = /(\d+)\s+comp[ée]tences?\s+de\s+plus/i;

const clean = (t) => (t ? String(t).replace(/\s+/g, " ").trim() : "");

const uniqCaseInsensitive = (arr) => {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const val = clean(item);
    if (!val) continue;
    const key = val.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(val);
  }
  return out;
};

const findLastLabelSlice = (raw) => {
  const matches = [...raw.matchAll(/comp[ée]tences/gi)];
  if (!matches.length) return raw;
  const last = matches[matches.length - 1];
  return raw.slice(last.index + last[0].length);
};

export function extractSkillsFromExperienceItem(li) {
  if (!li?.querySelector) return { skills: [], skillsMoreCount: null };
  const scope = li.querySelector(".pvs-entity__sub-components") || li;
  if (!scope) return { skills: [], skillsMoreCount: null };

  const candidates = Array.from(scope.querySelectorAll("span, div, p")).filter((node) =>
    SKILLS_LABEL_RE.test(node.textContent || "")
  );
  if (!candidates.length) return { skills: [], skillsMoreCount: null };

  const chosen = candidates.sort(
    (a, b) => (a.textContent || "").length - (b.textContent || "").length
  )[0];

  const raw = chosen?.textContent || "";
  let after = findLastLabelSlice(raw);
  const colonIndex = after.lastIndexOf(":");
  if (colonIndex >= 0) {
    after = after.slice(colonIndex + 1);
  } else {
    const rawColonIndex = raw.lastIndexOf(":");
    if (rawColonIndex >= 0) {
      after = raw.slice(rawColonIndex + 1);
    }
  }

  let skillsMoreCount = null;
  const moreMatch = after.match(MORE_RE);
  if (moreMatch) {
    skillsMoreCount = Number.parseInt(moreMatch[1], 10);
    after = after.replace(MORE_RE, "");
  }

  const separator = after.includes("·") ? "·" : "\n";
  const tokens = after
    .split(separator)
    .map(clean)
    .filter(Boolean)
    .filter((t) => !/comp[ée]tences/i.test(t));

  const skills = uniqCaseInsensitive(tokens);
  return { skills, skillsMoreCount };
}
