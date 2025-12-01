(() => {
  const FOCALS_DEBUG = true;

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

  const env = {
    href: window.location.href,
    origin: window.location.origin,
    isTop: window === window.top,
    isSandbox:
      document.origin === "null" ||
      window.location.origin === "null" ||
      !!window.frameElement?.hasAttribute("sandbox"),
  };

  if (!env.isTop) {
    debugLog("EXIT", "Not in top window, exiting messaging script");
    return;
  }
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

    const EDITOR_SELECTOR = "div.msg-form__contenteditable";
    const BUTTON_CLASS = "focals-suggest-reply-button";
    const FOCALS_GENERATE_REPLY_URL =
      "https://ppawceknsedxaejpeylu.supabase.co/functions/v1/focals-generate-reply";
    const STORAGE_KEYS = {
      settings: "FOCALS_SETTINGS",
      templates: "FOCALS_TEMPLATES",
      activeTemplate: "FOCALS_ACTIVE_TEMPLATE",
      jobs: "FOCALS_JOBS",
      activeJob: "FOCALS_ACTIVE_JOB",
    };

    const DEFAULT_SETTINGS = {
      tone: "friendly",
      languageFallback: "en",
      followUpPreference: "next_steps",
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

    const DEFAULT_JOBS = [
      {
        id: "default_job",
        title: "Full-Stack Engineer",
        description:
          "We are hiring a pragmatic full-stack engineer who can ship end-to-end features with React/TypeScript and Node. Emphasis on ownership, clean communication, and shipping reliable customer-facing features.",
        keywords: ["React", "TypeScript", "Node", "shipping", "customer focus"],
      },
    ];

    const normalizeText = (text = "") => text.replace(/\s+/g, " ").trim();

    const log = (message, ...args) => {
      debugLog("LOG", { message, args });
    };

    const warn = (message, ...args) => {
      debugLog("WARN", { message, args });
    };

    const error = (message, ...args) => {
      debugLog("ERROR", { message, args });
    };

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
      const cleaned = normalizeText(conversationName).replace(/\s*\([^)]*\)/g, "");
      const delimiters = ["|", "·", "•", "-", "—", " avec ", " with "];
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

    const buildFollowUpContext = (messages = [], job = null, preference = "next_steps") => {
      const lastUserMessage = messages.filter((m) => !m.fromMe).slice(-1)[0];
      const highlight = lastUserMessage ? lastUserMessage.text.slice(0, 240) : "";

      return {
        preference,
        highlight,
        jobTitle: job?.title || "",
        jobDescription: job?.description || "",
        jobKeywords: job?.keywords || [],
      };
    };

    const loadUserPreferences = async () => {
      const [syncData, localData] = await Promise.all([
        getFromStorage("sync", {
          [STORAGE_KEYS.settings]: DEFAULT_SETTINGS,
          [STORAGE_KEYS.templates]: DEFAULT_TEMPLATES,
          [STORAGE_KEYS.activeTemplate]: DEFAULT_TEMPLATES[0].id,
        }),
        getFromStorage("local", {
          [STORAGE_KEYS.jobs]: DEFAULT_JOBS,
          [STORAGE_KEYS.activeJob]: DEFAULT_JOBS[0].id,
        }),
      ]);

      const settings = { ...DEFAULT_SETTINGS, ...(syncData?.[STORAGE_KEYS.settings] || {}) };

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

      const jobs = Array.isArray(localData?.[STORAGE_KEYS.jobs]) ? localData[STORAGE_KEYS.jobs] : DEFAULT_JOBS;
      const activeJobId = localData?.[STORAGE_KEYS.activeJob] || jobs?.[0]?.id;
      const activeJob = jobs.find((job) => job.id === activeJobId) || jobs[0];

      if (!localData?.[STORAGE_KEYS.jobs]) {
        await setInStorage("local", {
          [STORAGE_KEYS.jobs]: jobs,
          [STORAGE_KEYS.activeJob]: activeJob?.id,
        });
      }

      return { settings, templates, activeTemplate, jobs, activeJob };
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

    const extractLinkedInMessages = (rootElement = document) => {
      const usingDocument = rootElement === document;
      log(
        `[SCRAPE] Using ${usingDocument ? "document" : "scoped root"} for messages`
      );

      const messageNodes = Array.from(
        rootElement.querySelectorAll(
          'div.msg-s-event-listitem[data-view-name="message-list-item"]'
        )
      );

      log(
        `[SCRAPE] Found ${messageNodes.length} message items${
          usingDocument ? "" : " in scoped conversation root"
        }`
      );

      if (!messageNodes.length && !usingDocument) {
        warn("[SCRAPE] No messages found in scoped root, not falling back to document");
      }

      const allMessages = [];

      messageNodes.forEach((container) => {
        const body = container.querySelector("p.msg-s-event-listitem__body");
        const text = normalizeText(body?.innerText || "");

        if (!text) {
          log("[SCRAPE] No body text for this message, skipping");
          return;
        }

        const fromMe = !container.classList.contains("msg-s-event-listitem--other");
        log(`[SCRAPE] Message role resolved: fromMe = ${fromMe}`);

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
        };

        log("[SCRAPE] Built message object:", {
          fromMe,
          length: text.length,
          timestampRaw,
        });

        allMessages.push(message);
      });

      if (!allMessages.length) {
        warn("[SCRAPE] No messages found after parsing");
        return [];
      }

      const recentMessages = allMessages.slice(-3);
      if (allMessages.length > 3) {
        log(`[SCRAPE] Using last 3 messages out of ${allMessages.length}`);
      }

      return recentMessages;
    };

    const generateReplyFromAPI = async (
      messages,
      {
        settings = DEFAULT_SETTINGS,
        template,
        job,
        conversationName = "",
        candidateName = "",
        followUp,
        customInstructions,
        mode = "auto",
      } = {}
    ) => {
      if (!messages?.length) {
        warn("PIPELINE extract_messages: no messages found, aborting");
        return null;
      }

      log(`PIPELINE api_call: about to call generate-reply`);
      log(`PIPELINE api_call: start (${messages.length} messages)`);

      const trimmedInstructions = (customInstructions || "").trim();

      const payload = {
        messages,
        context: {
          language: settings.languageFallback,
          tone: settings.tone,
          role: "recruiter",
          candidateName,
          conversationName,
          template,
          job,
          followUp,
        },
        mode,
        customInstructions: trimmedInstructions || undefined,
      };

      let response;
      try {
        response = await fetch(FOCALS_GENERATE_REPLY_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        error(`PIPELINE api_call: network failure`, err);
        throw err;
      }

      log(`PIPELINE api_call: response status = ${response.status}`);

      let data = null;
      if (!response.ok) {
        try {
          data = await response.json();
        } catch (parseErr) {
          data = null;
        }
        error(`PIPELINE api_call: error response`, {
          status: response.status,
          body: data,
        });
        return null;
      }

      try {
        data = await response.json();
      } catch (parseErr) {
        error(`PIPELINE api_call: failed to parse JSON`, parseErr);
        return null;
      }

      const replyPresent = !!data?.reply;
      log(`PIPELINE api_call: reply present = ${replyPresent}`);

      return data?.reply || null;
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
      mode = "auto",
      customInstructions,
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

        const { settings, activeTemplate, activeJob } = await loadUserPreferences();
        const language = detectLanguageFromMessages(messages, settings.languageFallback);
        const candidateName = detectCandidateName(conversationName, messages);
        const followUp = buildFollowUpContext(messages, activeJob, settings.followUpPreference);

        const reply = await generateReplyFromAPI(messages, {
          settings: { ...settings, languageFallback: language },
          template: activeTemplate,
          job: activeJob,
          conversationName,
          candidateName,
          followUp,
          customInstructions,
          mode,
        });
        if (!reply) {
          warn(`PIPELINE api_call: reply missing, aborting`);
          alert("❌ Impossible de générer une réponse pour le moment.");
          return;
        }

        const inserted = insertReplyIntoMessageInput(reply, {
          composer,
          conversationName,
        });
        log(`PIPELINE insert_reply: success = ${inserted}`);
      } catch (err) {
        error(`PIPELINE_ERROR ${err?.message || err}`);
        alert(`❌ Une erreur est survenue : ${err?.message || err}`);
      }
    };

    const scanAndInject = () => {
      const editors = Array.from(document.querySelectorAll(EDITOR_SELECTOR));
      log(`[SCAN] editors.length = ${editors.length}`);

      editors.forEach((editor, index) => {
        const composer = editor.closest(".msg-form");
        if (!composer) {
          warn("[SCAN] Unable to resolve composer for editor, skipping");
          return;
        }

        const footer = composer.querySelector("footer.msg-form__footer");
        if (!footer) {
          warn("[SCAN] Missing footer in composer, skipping");
          return;
        }

        const rightActions = footer.querySelector(".msg-form__right-actions");
        if (!rightActions) {
          warn("[SCAN] Missing right actions container, skipping");
          return;
        }

        const conversationRoot = resolveConversationRoot(composer);
        const conversationName = resolveConversationName(conversationRoot);

        if (composer.dataset.focalsBound === "true") {
          log(
            `[MSG] BUTTON_BIND_SKIP already bound for this composer (conversation: "${conversationName}")`
          );
          return;
        }

        const buttonRow = document.createElement("div");
        buttonRow.className = BUTTON_CLASS;
        buttonRow.style.display = "flex";
        buttonRow.style.gap = "6px";
        buttonRow.style.marginLeft = "8px";

        const controlsWrapper = document.createElement("div");
        controlsWrapper.style.position = "relative";
        controlsWrapper.style.display = "flex";
        controlsWrapper.style.flexDirection = "column";
        controlsWrapper.style.alignItems = "flex-end";
        controlsWrapper.style.flex = "1";

        const suggestButton = document.createElement("button");
        suggestButton.className = "artdeco-button artdeco-button--1";
        suggestButton.textContent = "Suggest reply";
        suggestButton.style.padding = "6px 10px";
        suggestButton.style.cursor = "pointer";
        suggestButton.style.flex = "1";

        const promptButton = document.createElement("button");
        promptButton.className = "artdeco-button artdeco-button--1";
        promptButton.textContent = "Prompt reply ▼";
        promptButton.style.padding = "6px 10px";
        promptButton.style.cursor = "pointer";
        promptButton.style.flex = "1";
        promptButton.style.background = "#f3f3f3";
        promptButton.style.borderColor = "#d0d0d0";
        promptButton.style.color = "#333";

        const popover = document.createElement("div");
        popover.style.display = "none";
        popover.style.flexDirection = "column";
        popover.style.gap = "10px";
        popover.style.position = "absolute";
        popover.style.bottom = "48px";
        popover.style.right = "0";
        popover.style.width = "340px";
        popover.style.background = "#ffffff";
        popover.style.border = "1px solid #d0d0d0";
        popover.style.borderRadius = "8px";
        popover.style.boxShadow = "0 10px 30px rgba(0, 0, 0, 0.12)";
        popover.style.padding = "14px";
        popover.style.zIndex = "2147483647";

        const replyState = {
          replyMode: "initial",
          promptReply: "",
          isPanelOpen: false,
        };

        const popoverTitle = document.createElement("div");
        popoverTitle.textContent = "Mode de réponse IA";
        popoverTitle.style.fontSize = "14px";
        popoverTitle.style.fontWeight = "600";
        popoverTitle.style.color = "#111827";

        const popoverDescription = document.createElement("div");
        popoverDescription.textContent =
          "Choisissez le type de réponse à générer puis, si besoin, donnez des instructions à l’IA.";
        popoverDescription.style.fontSize = "12px";
        popoverDescription.style.color = "#4b5563";
        popoverDescription.style.lineHeight = "1.4";

        const modesContainer = document.createElement("div");
        modesContainer.style.display = "grid";
        modesContainer.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
        modesContainer.style.gap = "8px";

        const modes = [
          { label: "Initial", value: "initial" },
          { label: "Relance douce", value: "followup_soft" },
          { label: "Relance forte", value: "followup_strong" },
          { label: "Prompt personnalisé", value: "prompt_reply" },
        ];

        const modeButtons = [];

        modes.forEach(({ label, value }) => {
          const modeButton = document.createElement("button");
          modeButton.textContent = label;
          modeButton.dataset.value = value;
          modeButton.style.padding = "8px 10px";
          modeButton.style.border = "1px solid #d0d0d0";
          modeButton.style.borderRadius = "999px";
          modeButton.style.background = "#f3f3f3";
          modeButton.style.cursor = "pointer";
          modeButton.style.fontSize = "13px";
          modeButton.style.color = "#333";
          modeButton.style.transition = "background 0.15s ease";

          modeButton.addEventListener("click", () => {
            replyState.replyMode = value;
            syncUI();
          });

          modeButtons.push(modeButton);
          modesContainer.appendChild(modeButton);
        });

        const instructionsBlock = document.createElement("div");
        instructionsBlock.style.display = "none";
        instructionsBlock.style.flexDirection = "column";
        instructionsBlock.style.gap = "6px";

        const promptLabel = document.createElement("label");
        promptLabel.textContent =
          "Instructions personnalisées pour guider la réponse";
        promptLabel.style.fontSize = "12px";
        promptLabel.style.color = "#4b5563";

        const promptInput = document.createElement("textarea");
        promptInput.placeholder =
          "Ex : réponds en 3 phrases maximum, propose un call cette semaine, garde un ton chaleureux et concret.";
        promptInput.maxLength = 500;
        promptInput.style.width = "100%";
        promptInput.style.minHeight = "96px";
        promptInput.style.resize = "vertical";
        promptInput.style.padding = "10px";
        promptInput.style.borderRadius = "8px";
        promptInput.style.border = "1px solid #d1d5db";
        promptInput.style.fontSize = "13px";
        promptInput.style.outline = "none";
        promptInput.addEventListener("focus", () => {
          promptInput.style.boxShadow = "0 0 0 2px rgba(14,118,168,0.2)";
        });
        promptInput.addEventListener("blur", () => {
          promptInput.style.boxShadow = "none";
        });

        promptInput.addEventListener("input", () => {
          replyState.promptReply = promptInput.value;
          syncUI();
        });

        instructionsBlock.appendChild(promptLabel);
        instructionsBlock.appendChild(promptInput);

        const promptGenerate = document.createElement("button");
        promptGenerate.textContent = "Générer la réponse";
        promptGenerate.className = "artdeco-button artdeco-button--1";
        promptGenerate.style.width = "100%";
        promptGenerate.style.padding = "10px";
        promptGenerate.style.cursor = "pointer";

        const syncUI = () => {
          modeButtons.forEach((btn) => {
            const isActive = btn.dataset.value === replyState.replyMode;
            btn.style.background = isActive ? "#0a66c2" : "#f3f3f3";
            btn.style.color = isActive ? "#ffffff" : "#333";
            btn.style.borderColor = isActive ? "#0a66c2" : "#d0d0d0";
          });

          const shouldShowInstructions = replyState.replyMode === "prompt_reply";
          instructionsBlock.style.display = shouldShowInstructions ? "flex" : "none";

          const hasValidPrompt = (replyState.promptReply || "").trim().length > 0;
          promptGenerate.disabled = shouldShowInstructions && !hasValidPrompt;

          popover.style.display = replyState.isPanelOpen ? "flex" : "none";
          promptButton.style.background = replyState.isPanelOpen ? "#e5e7eb" : "#f3f3f3";
          promptButton.style.borderColor = replyState.isPanelOpen ? "#a3a3a3" : "#d0d0d0";
          promptButton.textContent = replyState.isPanelOpen
            ? "Prompt reply ▲"
            : "Prompt reply ▼";
        };

        const closePanel = () => {
          replyState.isPanelOpen = false;
          syncUI();
        };

        promptGenerate.addEventListener("click", async () => {
          const originalText = promptGenerate.textContent;
          const originalDisabled = promptGenerate.disabled;
          const originalOpacity = promptGenerate.style.opacity;

          promptGenerate.disabled = true;
          promptGenerate.textContent = "⏳ Génération...";
          promptGenerate.style.opacity = "0.7";

          try {
            await runSuggestReplyPipeline({
              button: promptGenerate,
              composer,
              conversationRoot,
              conversationName,
              editorIndex: index + 1,
              mode: replyState.replyMode,
              customInstructions:
                replyState.replyMode === "prompt_reply"
                  ? (replyState.promptReply || "").trim()
                  : null,
            });
          } finally {
            promptGenerate.disabled = originalDisabled;
            promptGenerate.textContent = originalText;
            promptGenerate.style.opacity = originalOpacity;
            closePanel();
          }
        });

        log("[MSG] BUTTON_BIND", {
          conversation: conversationName,
          composerId: composer.id || null,
          editorIndex: index + 1,
        });

        suggestButton.addEventListener("click", async () => {
          const originalText = suggestButton.textContent;
          const originalDisabled = suggestButton.disabled;
          const originalOpacity = suggestButton.style.opacity;

          suggestButton.disabled = true;
          suggestButton.textContent = "⏳ Génération...";
          suggestButton.style.opacity = "0.7";
          closePanel();
          log(
            `[MSG][UI] Button set to loading (conversation: "${conversationName}")`
          );

          try {
            await runSuggestReplyPipeline({
              button: suggestButton,
              composer,
              conversationRoot,
              conversationName,
              editorIndex: index + 1,
              mode: "auto",
            });
          } finally {
            suggestButton.disabled = originalDisabled;
            suggestButton.textContent = originalText;
            suggestButton.style.opacity = originalOpacity;
            log(
              `[MSG][UI] Button restored to idle (conversation: "${conversationName}")`
            );
          }
        });

        promptButton.addEventListener("click", () => {
          replyState.isPanelOpen = !replyState.isPanelOpen;
          syncUI();
          if (replyState.isPanelOpen) {
            promptInput.focus();
          }
        });

        document.addEventListener("click", (event) => {
          const target = event.target;
          if (!replyState.isPanelOpen) return;
          if (popover.contains(target) || promptButton.contains(target)) return;
          closePanel();
        });

        popover.appendChild(popoverTitle);
        popover.appendChild(popoverDescription);
        popover.appendChild(modesContainer);
        popover.appendChild(instructionsBlock);
        popover.appendChild(promptGenerate);

        buttonRow.appendChild(suggestButton);
        buttonRow.appendChild(promptButton);

        controlsWrapper.appendChild(buttonRow);
        controlsWrapper.appendChild(popover);

        rightActions.appendChild(controlsWrapper);

        syncUI();
        composer.dataset.focalsBound = "true";

        log("[MSG] Suggest and prompt reply buttons injected", {
          conversation: conversationName,
          editorIndex: index + 1,
        });
      });
    };

    const initMessagingWatcher = () => {
      scanAndInject();

      const startObserver = () => {
        const observer = new MutationObserver(() => {
          scanAndInject();
        });

        observer.observe(document.body, { childList: true, subtree: true });
      };

      if (document.body) {
        startObserver();
      } else {
        document.addEventListener("DOMContentLoaded", () => {
          scanAndInject();
          startObserver();
        });
      }

      setInterval(scanAndInject, 1000);
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
