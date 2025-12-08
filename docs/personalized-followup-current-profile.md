# Prompt Codex – Personalized follow-up must use the current conversation profile

You are Codex, a Chrome extension running on LinkedIn.
Your goal is to generate a personalized follow-up for the candidate of the currently open conversation, even if the last scraped profile in memory belongs to someone else.

## Workflow for "Smart Reply → Personalized follow-up"

1. **Identify the candidate profile link from the conversation header**
   - Work inside the currently open LinkedIn messaging panel.
   - In the header of the conversation, find the `<a>` element that points to the candidate’s LinkedIn profile, for example:

   ```html
   <a href="/in/ACoAABCYYPMBv0_Bftbn7-zc4ki3VJDSQI_92kE/" id="ember710" class="ember-view" style="display: flex; gap: 8px; width: fit-content; text-decoration: none;">
     <span class="t-14 t-bold hoverable-link-text t-black">
       Cyril Lesage
     </span>
     ...
   </a>
   ```

   - Target rules:
     - `a[href*="/in/"]` inside the conversation header container.
     - It usually contains a `<span>` with classes like `hoverable-link-text` and the candidate’s name.

   - From this `<a>` element, extract:
     - `href` (profile path, e.g. `/in/ACoAABCYYPMBv0_Bftbn7-zc4ki3VJDSQI_92kE/`)
     - Inner text of the `<span>` (candidate name, e.g. `Cyril Lesage`)

2. **Build the full profile URL**
   - If `href` is relative (starts with `/in/`), prepend `https://www.linkedin.com` to get the full URL: `https://www.linkedin.com/in/ACoAABCYYPMBv0_Bftbn7-zc4ki3VJDSQI_92kE/`.

3. **Scrape the profile from this URL (always fresh)**
   - Call your existing scraping pipeline using this URL only.
   - Ignore any previously cached profile data: the source of truth must be the profile corresponding to this `<a>` element.
   - From the profile page, extract at least:
     - full name
     - headline / current role
     - current company
     - location
     - main experiences (titles, companies, dates)
     - skills / tech stack if available
   - If possible, open the profile in a background tab instead of navigating away from the current tab (e.g., `window.open(profileUrl, '_blank')` or use your internal tab-management helpers). Close the temporary tab once scraping is done.

4. **Combine profile + job description**
   - Use the freshly scraped profile data plus the current job description associated in Focals.
   - Do not rely on any old `currentProspect` object if its URL does not match the `<a>` you just read.

5. **Generate the personalized follow-up**
   - Call the Smart Reply backend in `personalized_followup` mode with:
     - candidate profile data (from the URL you just scraped)
     - job description
     - current message history (thread content)
   - Insert the generated message into the LinkedIn message composer of the currently open conversation.

6. **Fallback behavior**
   - If you cannot find any `<a href="/in/...">` element in the conversation header:
     - Log an error to the console (for debugging).
     - As a fallback, you may use the last valid associated profile, but only if no `<a>` link is found at all.

## Key constraint
For Personalized follow-up, the candidate identity is always determined by the `<a href="/in/...">` element of the current messaging panel, not by any previous state. This avoids mixing names/experiences when the open messaging thread does not match the last viewed profile.

## Optional helper

Pseudo-code for the overall flow:

```javascript
async function handlePersonalizedFollowup() {
  const link = findProfileLinkFromCurrentThread();
  const profileUrl = normalizeLinkedInUrl(link.href);
  const profileData = await scrapeProfile(profileUrl);
  const jd = await getCurrentJobDescription();
  const reply = await generatePersonalizedFollowup(profileData, jd, getThreadHistory());
  injectReplyIntoComposer(reply);
}
```

If needed, implement `findProfileLinkFromCurrentThread()` with robust selectors and error handling to ensure the header link is always the single source of truth.
