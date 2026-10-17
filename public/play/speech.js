// Hold-to-talk speech recognition wrapper (Web Speech API).
// usage:
//   import { speechSupported, createSpeech } from "/play/speech.js";
//   const sp = createSpeech({ onInterim(text), onFinal(text), onError(code, msg), onState(active) });
//   sp.start(); ... sp.stop();

const SR = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

export const speechSupported = !!SR;

const ERROR_MESSAGES = {
  "not-allowed": "Microphone blocked — allow mic access or type your answer.",
  "service-not-allowed": "Voice input isn't available here — please type your answer.",
  "audio-capture": "No microphone found — please type your answer.",
  "network": "Voice needs a network connection — please type your answer.",
  "no-speech": "Didn't catch that — hold the mic and speak.",
  "language-not-supported": "Voice language not supported — please type.",
};

export function createSpeech({ onInterim, onFinal, onError, onState } = {}) {
  let rec = null;
  let active = false;
  let text = "";
  let gotText = false;
  let finalizeTimer = 0;
  let finished = false;
  let stopping = false;

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(finalizeTimer);
    active = false;
    onState?.(false);
    if (gotText) onFinal?.(text.trim());
    rec = null;
  }

  function start() {
    if (!SR || active) return false;
    try {
      rec = new SR();
    } catch (e) {
      onError?.("init", "Voice input couldn't start — please type.");
      return false;
    }
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    text = "";
    gotText = false;
    finished = false;
    stopping = false;
    const mine = rec;
    rec.onresult = (ev) => {
      if (finished || rec !== mine) return;
      let fin = "";
      let interim = "";
      for (let i = 0; i < ev.results.length; i++) {
        const r = ev.results[i];
        const t = r[0]?.transcript || "";
        if (r.isFinal) fin += " " + t;
        else interim += " " + t;
      }
      text = (fin + " " + interim).replace(/\s+/g, " ").trim();
      if (text) {
        gotText = true;
        onInterim?.(text);
      }
    };
    rec.onerror = (ev) => {
      const code = ev.error || "unknown";
      if (code === "aborted") return;
      // "no-speech" on a quick tap is common; only report when nothing was heard at all.
      if (code === "no-speech" && gotText) return;
      onError?.(code, ERROR_MESSAGES[code] || "Voice input error — please type your answer.");
    };
    rec.onend = () => { if (rec === mine) finish(); };
    try {
      rec.start();
    } catch (e) {
      rec = null;
      onError?.("start", "Voice input couldn't start — please type.");
      return false;
    }
    active = true;
    onState?.(true);
    return true;
  }

  function stop() {
    if (!rec || !active || stopping) return;
    stopping = true;
    try { rec.stop(); } catch {}
    // Some browsers never fire onend after stop(); finalize ourselves.
    clearTimeout(finalizeTimer);
    finalizeTimer = setTimeout(() => {
      try { rec?.abort(); } catch {}
      finish();
    }, 1800);
  }

  function abort() {
    if (!rec) return;
    gotText = false;
    try { rec.abort(); } catch {}
    finish();
  }

  return { start, stop, abort, get active() { return active; } };
}
