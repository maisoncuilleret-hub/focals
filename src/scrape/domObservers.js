import { createLogger } from "../utils/logger.js";

const logger = createLogger("DomObserver");

function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

let activeObserver = null;

export function createDomObserver({ targetSelector = "main", debounceMs = 500, onStable }) {
  if (activeObserver) {
    activeObserver.disconnect();
    activeObserver = null;
  }

  const target = document.querySelector(targetSelector) || document.body;
  const debounced = debounce(onStable, debounceMs);
  const obs = new MutationObserver((mutations) => {
    const relevant = mutations.some((m) => m.addedNodes?.length || m.removedNodes?.length);
    if (!relevant) return;
    debounced("mutation");
  });

  return {
    start() {
      if (activeObserver) activeObserver.disconnect();
      obs.observe(target, { childList: true, subtree: true });
      activeObserver = obs;
      logger.debug("Mutation observer started on", targetSelector);
    },
    stop() {
      obs.disconnect();
      if (activeObserver === obs) activeObserver = null;
      logger.debug("Mutation observer stopped");
    },
    disconnect() {
      obs.disconnect();
      if (activeObserver === obs) activeObserver = null;
    },
  };
}

let navigationListenerInstalled = false;

export function listenToNavigation(onChange) {
  if (navigationListenerInstalled) return;
  navigationListenerInstalled = true;
  let lastHref = location.href;

  const fire = () => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      onChange("navigation");
    }
  };

  const patch = (fnName) => {
    const original = history[fnName];
    if (!original || original.__FOCALS_PATCHED) return;
    history[fnName] = function patchedHistory() {
      const result = original.apply(this, arguments);
      fire();
      return result;
    };
    history[fnName].__FOCALS_PATCHED = true;
  };

  patch("pushState");
  patch("replaceState");
  window.addEventListener("popstate", fire);
}
