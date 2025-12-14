import { createLogger } from "../utils/logger.js";

export const ScrapeState = {
  IDLE: "IDLE",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
  STOPPED: "STOPPED",
  ERROR: "ERROR",
};

export class ScrapeController {
  constructor({ onScrape, onStateChange } = {}) {
    this.logger = createLogger("ScrapeController");
    this.onScrape = onScrape;
    this.onStateChange = onStateChange;
    this.state = ScrapeState.IDLE;
    this.currentPromise = null;
    this.aborted = false;
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.logger.info("State ->", next);
    if (this.onStateChange) this.onStateChange(next);
  }

  async trigger(reason = "manual") {
    if (this.state !== ScrapeState.RUNNING) return;
    if (this.currentPromise) {
      this.logger.debug("Scrape already running, skipping", reason);
      return;
    }
    if (!this.onScrape) return;

    this.aborted = false;
    this.currentPromise = (async () => {
      try {
        await this.onScrape(reason, () => this.aborted);
      } catch (e) {
        this.logger.error("Scrape failed", e?.message || e);
        this.setState(ScrapeState.ERROR);
      } finally {
        this.currentPromise = null;
      }
    })();
    await this.currentPromise;
  }

  start() {
    this.aborted = false;
    this.setState(ScrapeState.RUNNING);
  }

  pause() {
    this.aborted = true;
    this.setState(ScrapeState.PAUSED);
  }

  stop() {
    this.aborted = true;
    this.setState(ScrapeState.STOPPED);
  }

  dispose() {
    this.aborted = true;
    this.setState(ScrapeState.STOPPED);
  }
}

export default ScrapeController;
