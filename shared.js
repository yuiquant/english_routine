// ---- Config ----
// Set this to your Cloudflare Worker URL after you deploy the proxy (see DEPLOY.md).
const WORKER_BASE_URL = "https://CHANGE-ME.workers.dev";
const API_PROXY_URL = WORKER_BASE_URL + "/v1/messages";
// Must match the SYNC_KEY secret you set on the Worker. Any string — just keeps
// strangers from writing to your synced data if they guess your Worker URL.
// (Obscurity, not real security — same caveat as everything else client-side here.)
const SYNC_KEY = "CHANGE-ME-make-up-a-random-string";
const MODEL = "claude-sonnet-4-6";
const ACTIVITY_KEY = "pfn-activity-log";
// Caps how many reviews one sitting shows you. Anything past this just waits for
// tomorrow — it isn't lost, and the most overdue items always get shown first so
// nothing important gets starved by the cap.
const DAILY_REVIEW_CAP = 12;

// ---- Date helpers ----
// Use LOCAL calendar date, not UTC — toISOString() alone gives the UTC date, which can
// be a full day off from the learner's actual "today" depending on timezone (e.g. NZ is
// UTC+12/13), silently breaking due-date math.
function localDateStr(d) {
  const offsetMs = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offsetMs).toISOString().slice(0, 10);
}
function todayStr() {
  return localDateStr(new Date());
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- Storage: syncs through the Worker's KV store so "web" and "home screen app" see
// the same data, with localStorage as an instant local cache / offline fallback. Same
// get/set/list/delete shape as the Claude-artifact window.storage API.
window.storage = {
  async get(key) {
    try {
      const res = await fetch(`${WORKER_BASE_URL}/data/${encodeURIComponent(key)}`, {
        headers: { "X-Sync-Key": SYNC_KEY },
      });
      if (!res.ok) {
        console.warn("[sync] GET failed", res.status, await res.text().catch(() => ""));
      }
      if (res.ok) {
        const data = await res.json();
        if (data && data.value !== null && data.value !== undefined) {
          localStorage.setItem(key, data.value);
          return { key, value: data.value };
        }
        // KV has never seen this key — if this device already has local data (e.g. it
        // was saved before sync was set up), push it up now so other devices can pull it.
        const localRaw = localStorage.getItem(key);
        if (localRaw !== null) {
          try {
            await fetch(`${WORKER_BASE_URL}/data/${encodeURIComponent(key)}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json", "X-Sync-Key": SYNC_KEY },
              body: JSON.stringify({ value: localRaw }),
            });
          } catch (e) {}
          return { key, value: localRaw };
        }
        throw new Error("not found: " + key);
      }
    } catch (e) {
      // offline or Worker unreachable — fall back to local cache below
    }
    const raw = localStorage.getItem(key);
    if (raw === null) throw new Error("not found: " + key);
    return { key, value: raw };
  },
  async set(key, value) {
    localStorage.setItem(key, value); // instant, always works even offline
    try {
      const res = await fetch(`${WORKER_BASE_URL}/data/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Sync-Key": SYNC_KEY },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) console.warn("[sync] PUT failed", res.status, await res.text().catch(() => ""));
    } catch (e) {
      console.warn("[sync] PUT error", e);
    }
    return { key, value };
  },
  async delete(key) {
    localStorage.removeItem(key);
    try {
      await fetch(`${WORKER_BASE_URL}/data/${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers: { "X-Sync-Key": SYNC_KEY },
      });
    } catch (e) {}
    return { key, deleted: true };
  },
  async list(prefix = "") {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(prefix));
    return { keys, prefix };
  },
};

// ---- Activity log (drives the Home dashboard action items) ----
function getActivityToday() {
  try {
    const raw = localStorage.getItem(ACTIVITY_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed.date !== todayStr()) return { date: todayStr(), notes: false, shadowing: false, speaking: false };
    return parsed;
  } catch (e) {
    return { date: todayStr(), notes: false, shadowing: false, speaking: false };
  }
}
function markActivity(kind) {
  const current = getActivityToday();
  current[kind] = true;
  localStorage.setItem(ACTIVITY_KEY, JSON.stringify(current));
}

// ---- SRS (SM-2 style, with leech detection and graduation) ----
// item.srs shape: { interval, ease, reps, dueDate, lastReviewed, consecutiveAgain, leech, graduated }
function nextSRS(srs, rating) {
  let { interval = 0, ease = 2.5, reps = 0, consecutiveAgain = 0 } = srs || {};
  if (rating === "again") {
    reps = 0;
    interval = 0;
    ease = Math.max(1.3, ease - 0.2);
    consecutiveAgain += 1;
  } else if (rating === "hard") {
    interval = Math.max(1, Math.round((interval || 1) * 1.2));
    ease = Math.max(1.3, ease - 0.15);
    reps += 1;
    consecutiveAgain = 0;
  } else if (rating === "good") {
    if (reps === 0) interval = 1;
    else if (reps === 1) interval = 3;
    else interval = Math.round(interval * ease);
    reps += 1;
    consecutiveAgain = 0;
  } else if (rating === "easy") {
    interval = Math.round((interval || 1) * ease * 1.3) + 1;
    ease = ease + 0.15;
    reps += 1;
    consecutiveAgain = 0;
  }
  const leech = consecutiveAgain >= 4;
  const graduated = reps >= 6 && interval >= 60;
  return {
    interval,
    ease,
    reps,
    consecutiveAgain,
    leech,
    graduated,
    dueDate: addDays(todayStr(), interval || 0),
    lastReviewed: todayStr(),
  };
}
function isDueToday(item) {
  return !item.srs.graduated && item.srs.dueDate <= todayStr();
}

// ---- Proxy-backed Claude API caller ----
async function callClaudeJSON(systemPrompt, content) {
  let res;
  try {
    res = await fetch(API_PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3000,
        system: systemPrompt,
        messages: [{ role: "user", content }],
      }),
    });
  } catch (e) {
    // Network-level failure (Safari says "Load failed", Chrome "Failed to fetch") —
    // the request never got a response at all: offline, proxy down, or CORS blocked.
    console.error("[api] network-level fetch failure", e);
    throw new Error("Couldn't reach the API proxy — check your connection, then try again.");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[api] HTTP error", res.status, body);
    if (res.status === 401 || res.status === 403) throw new Error("API key rejected (" + res.status + ") — check the ANTHROPIC_API_KEY secret on the Worker.");
    if (res.status === 429) throw new Error("Rate limited (429) — wait a moment and try again.");
    if (res.status >= 500) throw new Error("The API had a server error (" + res.status + ") — usually temporary, try again shortly.");
    throw new Error("API request failed (" + res.status + ")");
  }
  const data = await res.json();
  if (data.error) {
    console.error("[api] API returned an error object", data.error);
    throw new Error(data.error.message || "The API returned an error.");
  }
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text in response");
  if (data.stop_reason === "max_tokens") {
    console.error("[api] response was cut off at max_tokens", data);
    throw new Error("The response got cut off before it finished — try again.");
  }
  let raw = textBlock.text.trim();
  raw = raw.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error("[api] couldn't parse response as JSON:", raw);
    throw new Error("Got a malformed response — try again.");
  }
}

// ---- Speech recognition error messages ----
function speechErrorMessage(errorCode) {
  switch (errorCode) {
    case "not-allowed":
    case "service-not-allowed":
      return "Mic access is blocked — check your browser's site settings and allow the microphone for this page.";
    case "no-speech":
      return "Didn't catch any speech — try again.";
    case "audio-capture":
      return "No microphone found.";
    case "network":
      return "Speech recognition needs an internet connection.";
    case "aborted":
      return "";
    default:
      return `Mic error (${errorCode || "unknown"}) — you can type instead.`;
  }
}

// ---- Pick a MediaRecorder mimeType that this browser can both record AND play back.
// Safari doesn't support WebM playback at all, so we prefer mp4 there; Chrome/Firefox
// prefer webm. Always check isTypeSupported before using a candidate.
function pickMediaMimeType(kind) {
  const candidates = kind === "audio"
    ? ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]
    : ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}
