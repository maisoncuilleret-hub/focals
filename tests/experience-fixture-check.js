import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const clean = (t) => (t ? String(t).replace(/\s+/g, " ").trim() : "");
const looksLikeDates = (t) => /-|–|—/.test(clean(t)) && /(19\d{2}|20\d{2}|aujourd|present)/i.test(clean(t));

const parseFixtureItem = (li) => {
  const lines = Array.from(li.querySelectorAll("p, span[aria-hidden='true']")).map((n) => clean(n.textContent)).filter(Boolean);
  const title = clean(li.querySelector(".t-bold")?.textContent) || lines[0] || null;
  const date = lines.find((x) => looksLikeDates(x)) || null;
  let company = lines.find((x) => x !== title && x !== date && !looksLikeDates(x)) || null;
  if (company) company = clean(company.split("·")[0]);
  return { title, company, date };
};

const singleHtml = `
  <li componentkey="entity-collection-item-57bfdfd2">
    <div class="t-bold"><span aria-hidden="true">Software Engineer</span></div>
    <span aria-hidden="true">Storio Energy</span>
    <span aria-hidden="true">mai 2024 - aujourd’hui · 1 an 10 mois</span>
  </li>
`;
const groupedHtml = `
  <li componentkey="entity-collection-item--grp1">
    <div class="t-bold"><span aria-hidden="true">Example Corp</span></div>
    <div class="pvs-entity__sub-components">
      <ul>
        <li>
          <div class="t-bold"><span aria-hidden="true">Senior Engineer</span></div>
          <span aria-hidden="true">janv. 2022 - aujourd’hui · 3 ans</span>
        </li>
      </ul>
    </div>
  </li>
`;

const singleDom = new JSDOM(singleHtml);
const single = parseFixtureItem(singleDom.window.document.querySelector("li"));
assert.equal(single.title, "Software Engineer");
assert.equal(single.company, "Storio Energy");
assert.ok(single.date);

const groupedDom = new JSDOM(groupedHtml);
const groupRoot = groupedDom.window.document.querySelector("li");
const headerCompany = clean(groupRoot.querySelector(":scope > .t-bold")?.textContent);
const role = parseFixtureItem(groupRoot.querySelector(".pvs-entity__sub-components li"));
assert.equal(role.title, "Senior Engineer");
assert.equal(headerCompany, "Example Corp");
assert.ok(role.date);

console.log("fixture checks passed", { single, grouped: { ...role, company: headerCompany } });
