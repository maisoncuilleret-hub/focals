import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { extractDetailsDescription } from "../src/scrape/experienceDetailsDescription.js";

test("extracts only the real description from sub-components", () => {
  const html = `
    <li>
      <div class="pvs-entity__header">
        <span aria-hidden="true">AI Engineering Lead</span>
        <span aria-hidden="true">Jan 2020 – Present</span>
        <span aria-hidden="true">Paris</span>
      </div>
      <div class="pvs-entity__sub-components">
        <div class="inline-show-more-text">
          <span aria-hidden="true">Built and shipped ML systems across teams with measurable impact.</span>
        </div>
      </div>
    </li>
  `;
  const dom = new JSDOM(html);
  const li = dom.window.document.querySelector("li");
  const ctx = {
    title: "AI Engineering Lead",
    dates: "Jan 2020 – Present",
    location: "Paris",
  };
  const description = extractDetailsDescription(li, ctx);
  assert.equal(
    description,
    "Built and shipped ML systems across teams with measurable impact."
  );
});

test("dedupes consecutive identical lines", () => {
  const html = `
    <li>
      <div class="pvs-entity__sub-components">
        <div class="inline-show-more-text">
          <span aria-hidden="true">Repeated line here.<br>Repeated line here.<br>Another distinct line here.</span>
        </div>
      </div>
    </li>
  `;
  const dom = new JSDOM(html);
  const li = dom.window.document.querySelector("li");
  const description = extractDetailsDescription(li, { title: "" });
  assert.equal(description, "Repeated line here.\nAnother distinct line here.");
});

test("returns null when no real description is present", () => {
  const html = `
    <li>
      <div class="pvs-entity__header">
        <span aria-hidden="true">Open Source Hardware Rises</span>
        <span aria-hidden="true">Du janv. 2021 au déc. 2023</span>
      </div>
    </li>
  `;
  const dom = new JSDOM(html);
  const li = dom.window.document.querySelector("li");
  const ctx = {
    title: "Open Source Hardware Rises",
    dates: "Du janv. 2021 au déc. 2023",
  };
  const description = extractDetailsDescription(li, ctx);
  assert.equal(description, null);
});
