// ───────────────────────────────────────────────────────────────
//  English Study — Lock Screen widget
//  Paste this into a new script in the Scriptable app (free, App Store),
//  name it "English Study", then add a Scriptable widget to your Lock
//  Screen and set it to run this script.
// ───────────────────────────────────────────────────────────────

const WORKER = "https://english-study-proxy.nimbosjung.workers.dev";
const SYNC_KEY = "test123";
const APP_URL = "https://yuiquant.github.io/english_routine/notes.html";

async function getItem() {
  const req = new Request(`${WORKER}/next-review?key=${encodeURIComponent(SYNC_KEY)}`);
  req.timeoutInterval = 15;
  return await req.loadJSON();
}

function accessory(data) {
  // Lock Screen widgets are tiny and monochrome — show the expression only.
  const w = new ListWidget();
  w.addAccessoryWidgetBackground = true;
  w.setPadding(4, 6, 4, 6);

  if (!data || data.empty) {
    const t = w.addText("All caught up ✓");
    t.font = Font.semiboldSystemFont(12);
    t.minimumScaleFactor = 0.7;
    return w;
  }

  const expr = w.addText(data.text || "—");
  expr.font = Font.semiboldSystemFont(13);
  expr.minimumScaleFactor = 0.6;
  expr.lineLimit = 2;

  if (data.meaning) {
    const m = w.addText(data.meaning);
    m.font = Font.systemFont(10);
    m.minimumScaleFactor = 0.6;
    m.lineLimit = 2;
  }
  return w;
}

function homeScreen(data) {
  // Home Screen widgets have colour and room for the scenario prompt.
  const w = new ListWidget();
  w.backgroundColor = new Color("#EEF1EE");
  w.setPadding(14, 14, 14, 14);

  if (!data || data.empty) {
    const t = w.addText("Nothing due — go collect one.");
    t.font = Font.semiboldSystemFont(14);
    t.textColor = new Color("#14504D");
    return w;
  }

  const label = w.addText(`DUE ${data.due}`);
  label.font = Font.mediumSystemFont(9);
  label.textColor = new Color("#6B7269");
  w.addSpacer(6);

  const expr = w.addText(data.text || "—");
  expr.font = Font.boldSystemFont(17);
  expr.textColor = new Color("#14504D");
  expr.minimumScaleFactor = 0.6;
  expr.lineLimit = 2;

  if (data.meaning) {
    w.addSpacer(4);
    const m = w.addText(data.meaning);
    m.font = Font.systemFont(12);
    m.textColor = new Color("#1B1F23");
    m.minimumScaleFactor = 0.7;
    m.lineLimit = 2;
  }

  if (data.scenario) {
    w.addSpacer(6);
    const s = w.addText(data.scenario);
    s.font = Font.italicSystemFont(11);
    s.textColor = new Color("#6B7269");
    s.minimumScaleFactor = 0.7;
    s.lineLimit = 3;
  }

  w.addSpacer();
  return w;
}

let data = null;
try {
  data = await getItem();
} catch (e) {
  data = null;
}

const family = config.widgetFamily || "accessoryRectangular";
const widget = family.startsWith("accessory") ? accessory(data) : homeScreen(data);
widget.url = APP_URL; // tapping opens the full review app

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  // Running inside Scriptable — preview it.
  if (family.startsWith("accessory")) widget.presentAccessoryRectangular();
  else widget.presentMedium();
}
Script.complete();
