(() => {
  const INTERCEPTOR_FLAG = "__FOCALS_VOYAGER_INTERCEPTOR__";
  const MESSAGE_TYPE = "FOCALS_VOYAGER_RESPONSE";

  if (window[INTERCEPTOR_FLAG]) return;
  window[INTERCEPTOR_FLAG] = true;

  const shouldCaptureUrl = (input) => {
    if (!input) return false;
    try {
      const url = new URL(String(input), location.href);
      const path = url.pathname || "";
      return (
        /\/voyager\/api\/identity\//i.test(path) ||
        /\/voyager\/api\/graphql/i.test(path) ||
        /\/voyager\/api\/.*profile/i.test(path)
      );
    } catch {
      return false;
    }
  };

  const normalizeProfileCandidate = (candidate) => {
    if (!candidate || typeof candidate !== "object") return null;

    const firstName = candidate.firstName || candidate.firstNameLine || "";
    const lastName = candidate.lastName || candidate.lastNameLine || "";
    const fullName =
      candidate.fullName ||
      candidate.formattedName ||
      candidate.displayName ||
      `${firstName} ${lastName}`.trim();

    const headline =
      candidate.headline ||
      candidate.occupation ||
      candidate.title ||
      candidate.summary ||
      "";

    const location =
      candidate.locationName ||
      candidate.geoLocationName ||
      candidate.location ||
      candidate.city ||
      candidate.region ||
      (candidate.location && candidate.location.preferredName) ||
      "";

    const experiences = [];
    const experienceSources = [
      candidate.experience,
      candidate.experiences,
      candidate.positions,
      candidate.positionView,
      candidate.positionGroupView,
    ].filter(Boolean);

    for (const source of experienceSources) {
      const elements = Array.isArray(source?.elements)
        ? source.elements
        : Array.isArray(source)
          ? source
          : [];
      for (const item of elements) {
        if (!item || typeof item !== "object") continue;
        const title =
          item.title ||
          item.name ||
          item.positionName ||
          item.role ||
          item.jobTitle ||
          "";
        const company =
          item.companyName ||
          item.company ||
          item.employer ||
          item.subtitle ||
          (item.companyDetails && item.companyDetails.name) ||
          "";
        const combined = [title, company].filter(Boolean).join(" · ");
        if (combined) experiences.push(combined);
      }
    }

    const education = [];
    const educationSource =
      candidate.education || candidate.educationView || candidate.educations;
    const eduElements = Array.isArray(educationSource?.elements)
      ? educationSource.elements
      : Array.isArray(educationSource)
        ? educationSource
        : [];
    for (const item of eduElements) {
      if (!item || typeof item !== "object") continue;
      const school =
        item.schoolName ||
        item.school ||
        item.subtitle ||
        (item.schoolDetails && item.schoolDetails.name) ||
        "";
      const degree = item.degreeName || item.degree || item.credential || "";
      const field = item.fieldOfStudy || item.field || "";
      const combined = [school, degree, field].filter(Boolean).join(" · ");
      if (combined) education.push(combined);
    }

    const skills = [];
    const skillSource = candidate.skills || candidate.skillView || candidate.skillDetails;
    const skillElements = Array.isArray(skillSource?.elements)
      ? skillSource.elements
      : Array.isArray(skillSource)
        ? skillSource
        : [];
    for (const item of skillElements) {
      const name = item.name || item.skill || item.title || "";
      if (name) skills.push(name);
    }

    const entityUrn = candidate.entityUrn || candidate.objectUrn || "";
    const publicIdentifier = candidate.publicIdentifier || "";

    if (!fullName && !headline && !location && !entityUrn && !publicIdentifier) {
      return null;
    }

    return {
      fullName,
      headline,
      experiences,
      education,
      skills,
      location,
      entityUrn,
      publicIdentifier,
    };
  };

  const extractProfile = (payload) => {
    let normalized = normalizeProfileCandidate(payload);
    if (normalized) return normalized;

    const queue = [payload];
    const seen = new Set();

    while (queue.length) {
      const current = queue.shift();
      if (!current || typeof current !== "object" || seen.has(current)) continue;
      seen.add(current);

      normalized = normalizeProfileCandidate(current);
      if (normalized) return normalized;

      if (Array.isArray(current)) {
        for (const item of current) {
          queue.push(item);
        }
      } else {
        for (const value of Object.values(current)) {
          queue.push(value);
        }
      }
    }

    return {
      fullName: "",
      headline: "",
      experiences: [],
      education: [],
      skills: [],
      location: "",
      entityUrn: "",
      publicIdentifier: "",
    };
  };

  const emitVoyagerResponse = (url, payload) => {
    try {
      const normalizedProfile = extractProfile(payload || {});
      window.postMessage(
        {
          source: "focals",
          type: MESSAGE_TYPE,
          url,
          normalizedProfile,
          rawResponse: payload,
        },
        "*"
      );
    } catch (err) {
      console.warn("[Focals][Voyager] Failed to emit payload", err?.message || err);
    }
  };

  const captureResponse = (url, responsePromise) => {
    if (!shouldCaptureUrl(url)) return;
    responsePromise
      .then((resp) => resp.json())
      .then((json) => emitVoyagerResponse(url, json))
      .catch(() => {
        /* ignore JSON/parse errors to avoid breaking the page */
      });
  };

  const installFetchInterceptor = (win) => {
    if (!win || !win.fetch) return;
    if (win.__FOCALS_FETCH_PATCHED__) return;
    win.__FOCALS_FETCH_PATCHED__ = true;

    const originalFetch = win.fetch.bind(win);
    win.fetch = function patchedFetch(...args) {
      const response = originalFetch(...args);
      try {
        const url = args?.[0]?.url || args?.[0] || "";
        response
          .then((res) => {
            try {
              captureResponse(url, Promise.resolve(res.clone()));
            } catch {
              captureResponse(url, Promise.resolve(res));
            }
            return res;
          })
          .catch(() => {});
      } catch {
        // Swallow errors to avoid breaking the page
      }
      return response;
    };
  };

  const installXhrInterceptor = (win) => {
    if (!win || !win.XMLHttpRequest) return;
    if (win.__FOCALS_XHR_PATCHED__) return;
    win.__FOCALS_XHR_PATCHED__ = true;

    const OriginalXHR = win.XMLHttpRequest;
    function PatchedXHR() {
      const xhr = new OriginalXHR();
      let requestUrl = "";

      const originalOpen = xhr.open;
      xhr.open = function patchedOpen(method, url, ...rest) {
        try {
          requestUrl = url || "";
        } catch {
          requestUrl = "";
        }
        return originalOpen.call(xhr, method, url, ...rest);
      };

      xhr.addEventListener("load", () => {
        try {
          if (!shouldCaptureUrl(requestUrl)) return;
          const responseText = xhr.responseText;
          try {
            const parsed = JSON.parse(responseText);
            emitVoyagerResponse(requestUrl, parsed);
          } catch {
            // ignore parse errors
          }
        } catch {
          // ignore errors to keep XHR working
        }
      });

      return xhr;
    }

    PatchedXHR.prototype = OriginalXHR.prototype;
    win.XMLHttpRequest = PatchedXHR;
  };

  const injectionSource = `(${function () {
    const INTERCEPTOR_FLAG = "__FOCALS_VOYAGER_CHILD__";
    if (window[INTERCEPTOR_FLAG]) return;
    window[INTERCEPTOR_FLAG] = true;
    const MESSAGE_TYPE = "FOCALS_VOYAGER_RESPONSE";
    const shouldCaptureUrl = ${shouldCaptureUrl.toString()};
    const normalizeProfileCandidate = ${normalizeProfileCandidate.toString()};
    const extractProfile = ${extractProfile.toString()};
    const emitVoyagerResponse = ${emitVoyagerResponse.toString()};
    const captureResponse = ${captureResponse.toString()};
    const installFetchInterceptor = ${installFetchInterceptor.toString()};
    const installXhrInterceptor = ${installXhrInterceptor.toString()};
    installFetchInterceptor(window);
    installXhrInterceptor(window);
  }.toString()})();`;

  const injectIntoFrame = (frame) => {
    if (!frame || !(frame instanceof HTMLIFrameElement)) return;
    const applyInjection = () => {
      try {
        const frameWindow = frame.contentWindow;
        if (!frameWindow) return;
        frameWindow.eval(injectionSource);
      } catch {
        // ignore cross-origin frames
      }
    };

    applyInjection();
    frame.addEventListener("load", applyInjection, { passive: true });
  };

  const observeShadowRoot = (shadowRoot) => {
    if (!shadowRoot || shadowRoot.__FOCALS_SHADOW_OBSERVED__) return;
    shadowRoot.__FOCALS_SHADOW_OBSERVED__ = true;
    scanForFrames(shadowRoot);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          processNode(node);
        });
      }
    });
    observer.observe(shadowRoot, { childList: true, subtree: true });
  };

  const processNode = (node) => {
    if (!node) return;
    if (node instanceof HTMLIFrameElement) {
      injectIntoFrame(node);
    }

    if (node.shadowRoot) {
      observeShadowRoot(node.shadowRoot);
    }

    if (node.querySelectorAll) {
      node.querySelectorAll("iframe").forEach(injectIntoFrame);
      node.querySelectorAll("*").forEach((child) => {
        if (child.shadowRoot) observeShadowRoot(child.shadowRoot);
      });
    }
  };

  const scanForFrames = (root) => {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll("iframe").forEach(injectIntoFrame);
  };

  const installMutationObserver = (root) => {
    if (!root || root.__FOCALS_IFRAME_OBSERVER__) return;
    root.__FOCALS_IFRAME_OBSERVER__ = true;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => processNode(node));
      }
    });
    observer.observe(root, { childList: true, subtree: true });
  };

  const patchAttachShadow = () => {
    const original = Element.prototype.attachShadow;
    if (Element.prototype.__FOCALS_ATTACH_SHADOW_PATCHED__) return;
    Element.prototype.__FOCALS_ATTACH_SHADOW_PATCHED__ = true;
    Element.prototype.attachShadow = function patched(init) {
      const shadow = original.call(this, init);
      try {
        observeShadowRoot(shadow);
      } catch {
        // ignore shadow errors
      }
      return shadow;
    };
  };

  installFetchInterceptor(window);
  installXhrInterceptor(window);
  patchAttachShadow();
  scanForFrames(document);
  installMutationObserver(document);
  processNode(document.documentElement);

  if (window === window.top) {
    window.addEventListener("message", (event) => {
      const data = event?.data;
      if (!data || data.type !== MESSAGE_TYPE) return;
      try {
        console.log("[Focals][Voyager]", data.url, data.rawResponse);
        const detail = {
          url: data.url,
          profile: data.normalizedProfile,
          raw: data.rawResponse,
        };
        window.dispatchEvent(
          new CustomEvent("focals:voyager-profile", { detail })
        );
      } catch (err) {
        console.warn("[Focals][Voyager] Failed to handle message", err?.message || err);
      }
    });
  }
})();
