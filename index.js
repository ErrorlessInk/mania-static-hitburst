const judgeImg = document.getElementById("judge-img");

/* =========================
   config
========================= */
const CONFIG = {
  wsBase: "ws://127.0.0.1:24050",
  maniaOnly: true,
  clearWhenLeaveGameplay: true,
  imagePaths: {
    hit300g: "images/hit300g.png",
    hit300:  "images/hit300.png",
    hit200:  "images/hit200.png",
    hit100:  "images/hit100.png",
    hit50:   "images/hit50.png",
    hit0:    "images/hit0.png",
  }
};

/* =========================
   preload images
========================= */
function preloadImages(paths) {
  Object.values(paths).forEach((src) => {
    const img = new Image();
    img.src = src;
  });
}
preloadImages(CONFIG.imagePaths);

/* =========================
   websocket
========================= */
const wsV2 = new WebSocket(`${CONFIG.wsBase}/websocket/v2`);
const wsPrecise = new WebSocket(`${CONFIG.wsBase}/websocket/v2/precise`);

/* =========================
   State variables
========================= */
let currentOD = 5;
let hrEnabled = false;

let prevMissCount = 0;
let prevPreciseCount = 0;
let prevTotalJudgements = 0;
let prevBeatmapId = null;

/* =========================
   Utility functions
========================= */
function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function totalHits(hits) {
  return (
    safeNumber(hits["0"]) +
    safeNumber(hits["50"]) +
    safeNumber(hits["100"]) +
    safeNumber(hits["300"]) +
    safeNumber(hits["geki"]) +
    safeNumber(hits["katu"])
  );
}

function isManiaMode(data) {
  const modeNum = data?.play?.mode?.number;
  const modeName = String(data?.play?.mode?.name ?? "").toLowerCase();
  return modeNum === 3 || modeName === "mania";
}

function inGameplay(data) {
  return data?.state?.number === 2;
}

function getTimingWindows(od, hr) {
  let timing300g = 16;
  let timing300  = 64  - 3 * od;
  let timing200  = 97  - 3 * od;
  let timing100  = 127 - 3 * od;
  let timing50   = 151 - 3 * od;
  let timing0    = 188 - 3 * od;

  if (hr) {
    timing300g = 11.43;
    timing300 /= 1.4;
    timing200 /= 1.4;
    timing100 /= 1.4;
    timing50  /= 1.4;
    timing0   /= 1.4;
  }

  return { timing300g, timing300, timing200, timing100, timing50, timing0 };
}

function classifyHitError(errorMs, od, hr) {
  const x = Math.abs(errorMs);
  const w = getTimingWindows(od, hr);

  if (x <= w.timing300g) return "hit300g";
  if (x <= w.timing300)  return "hit300";
  if (x <= w.timing200)  return "hit200";
  if (x <= w.timing100)  return "hit100";
  if (x <= w.timing50)   return "hit50";
  return "hit0";
}

/* =========================
   Show / hide
========================= */
function showJudgeImage(key) {
  const src = CONFIG.imagePaths[key];
  if (!src) return;

  judgeImg.src = src;
  judgeImg.style.opacity = "1";
}

function hideJudgeImage() {
  judgeImg.src = "";
  judgeImg.style.opacity = "0";
}

function resetState({ keepBeatmapId = false } = {}) {
  prevMissCount = 0;
  prevPreciseCount = 0;
  prevTotalJudgements = 0;

  if (!keepBeatmapId) {
    prevBeatmapId = null;
  }

  hideJudgeImage();
}

/* =========================
   v2: handles gameplay / miss / reset
========================= */
wsV2.onmessage = (event) => {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch (err) {
    console.error("v2 JSON parse failed:", err);
    return;
  }

  if (CONFIG.maniaOnly && !isManiaMode(data)) {
    resetState();
    return;
  }

  if (CONFIG.clearWhenLeaveGameplay && !inGameplay(data)) {
    resetState({ keepBeatmapId: true });
    return;
  }

  currentOD = safeNumber(data?.beatmap?.stats?.od?.converted, currentOD);
  hrEnabled = String(data?.play?.mods?.name ?? "").includes("HR");

  const beatmapId = safeNumber(data?.beatmap?.id, 0);
  const hits = data?.play?.hits ?? {};
  const missCount = safeNumber(hits["0"], 0);
  const totalJudgements = totalHits(hits);

  // Switch beatmap
  if (prevBeatmapId !== null && beatmapId !== 0 && beatmapId !== prevBeatmapId) {
    resetState({ keepBeatmapId: true });
  }

  // retry / counter rollback
  if (totalJudgements < prevTotalJudgements) {
    resetState({ keepBeatmapId: true });
  }

  // miss
  if (missCount > prevMissCount) {
    showJudgeImage("hit0");
  }

  prevMissCount = missCount;
  prevTotalJudgements = totalJudgements;
  prevBeatmapId = beatmapId !== 0 ? beatmapId : prevBeatmapId;
};

wsV2.onopen = () => console.log("[judge] v2 connected");
wsV2.onclose = () => console.log("[judge] v2 closed");
wsV2.onerror = (e) => console.error("[judge] v2 error", e);

/* =========================
   precise: handles non-miss judgements
========================= */
wsPrecise.onmessage = (event) => {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch (err) {
    console.error("precise JSON parse failed:", err);
    return;
  }

  const hitErrors = Array.isArray(data?.hitErrors) ? data.hitErrors : [];

  // Reset after length rolls back
  if (hitErrors.length < prevPreciseCount) {
    prevPreciseCount = 0;
  }

  // Only process the newest added one
  if (hitErrors.length > prevPreciseCount) {
    const latestError = hitErrors[hitErrors.length - 1];

    if (typeof latestError === "number" && Number.isFinite(latestError)) {
      const result = classifyHitError(latestError, currentOD, hrEnabled);
      showJudgeImage(result);
    }
  }

  prevPreciseCount = hitErrors.length;
};

wsPrecise.onopen = () => console.log("[judge] precise connected");
wsPrecise.onclose = () => console.log("[judge] precise closed");
wsPrecise.onerror = (e) => console.error("[judge] precise error", e);