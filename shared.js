// ---- Config ----
// Set this to your Cloudflare Worker URL after you deploy the proxy (see DEPLOY.md).
const WORKER_BASE_URL = "https://english-study-proxy.nimbosjung.workers.dev";
const API_PROXY_URL = "https://english-study-proxy.nimbosjung.workers.dev/v1/messages";
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
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
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
  const res = await fetch(API_PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error("API request failed (" + res.status + ")");
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text in response");
  let raw = textBlock.text.trim();
  raw = raw.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  return JSON.parse(raw);
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
