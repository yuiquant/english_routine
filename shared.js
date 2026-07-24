// ---- Config ----
// Set this to your Cloudflare Worker URL after you deploy the proxy (see DEPLOY.md).
const API_PROXY_URL = "https://CHANGE-ME.workers.dev/v1/messages";
const MODEL = "claude-sonnet-4-6";
const ACTIVITY_KEY = "pfn-activity-log";

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

// ---- Storage shim: same shape as the Claude-artifact window.storage API ----
window.storage = {
  async get(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) throw new Error("not found: " + key);
    return { key, value: raw };
  },
  async set(key, value) {
    localStorage.setItem(key, value);
    return { key, value };
  },
  async delete(key) {
    localStorage.removeItem(key);
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
