import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { extractSkillsFromExperienceItem } from "../src/scrape/experienceDetailsSkills.js";

test("extracts skills when listed inline", () => {
  const html = `
    <li>
      <div class="pvs-entity__sub-components">
        <div>
          <span>Compétences : Machine Learning · Large Language Models (LLM)</span>
        </div>
      </div>
    </li>
  `;
  const dom = new JSDOM(html);
  const li = dom.window.document.querySelector("li");
  const result = extractSkillsFromExperienceItem(li);
  assert.deepEqual(result, {
    skills: ["Machine Learning", "Large Language Models (LLM)"],
    skillsMoreCount: null,
  });
});

test("extracts skills and '+N compétences de plus' count", () => {
  const html = `
    <li>
      <div class="pvs-entity__sub-components">
        <p>Compétences : Data Engineering · Cloud · +12 compétences de plus</p>
      </div>
    </li>
  `;
  const dom = new JSDOM(html);
  const li = dom.window.document.querySelector("li");
  const result = extractSkillsFromExperienceItem(li);
  assert.deepEqual(result, {
    skills: ["Data Engineering", "Cloud"],
    skillsMoreCount: 12,
  });
});

test("returns empty skills when no label is present", () => {
  const html = `
    <li>
      <div class="pvs-entity__sub-components">
        <p>Some other text</p>
      </div>
    </li>
  `;
  const dom = new JSDOM(html);
  const li = dom.window.document.querySelector("li");
  const result = extractSkillsFromExperienceItem(li);
  assert.deepEqual(result, { skills: [], skillsMoreCount: null });
});

test("ignores glued labels like PeopleCompétences", () => {
  const html = `
    <li>
      <div class="pvs-entity__sub-components">
        <span>PeopleCompétences : X · Y</span>
      </div>
    </li>
  `;
  const dom = new JSDOM(html);
  const li = dom.window.document.querySelector("li");
  const result = extractSkillsFromExperienceItem(li);
  assert.deepEqual(result, { skills: ["X", "Y"], skillsMoreCount: null });
});
