/* ==========================================================
   マチ冒険 MVP — 未踏セル開放 × 勾配クエスト
   ========================================================== */

const CELL_SIZE_M = 200;        // 1セルの一辺（メートル）
const QUEST_RING_CELLS = 4;     // 現在地から何セル分の範囲でクエスト候補を探すか（≒800m）
const MAX_QUEST_CANDIDATES = 10; // 標高APIに投げる候補数の上限
const ELEVATION_ENDPOINT = "https://api.open-elevation.com/api/v1/lookup";
const ELEVATION_TIMEOUT_MS = 8000; // 標高APIが固まった場合に諦めるまでの時間

const ACCURACY_OPEN_M = 60;   // これより誤差が大きい測位ではセル開放/クエスト達成の判定に使わない
const ACCURACY_WARN_M = 100;  // これより誤差が大きい場合はユーザーに知らせる
const ACCURACY_WARN_INTERVAL_MS = 15000; // 精度低下トーストを連発させないための間隔

// フロンティア・コンパス: 8方位ラベル（北を0として45度刻み・時計回り）
const COMPASS_LABELS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
const FRONTIER_COLLAPSE_DISTANCE_M = 30;  // 累積移動がこれを超えたら展開→縮小に切り替える
const FRONTIER_RECOMPUTE_DISTANCE_M = 100; // 前回の再計算地点からこれだけ動いたら方角を再計算する
const FRONTIER_SWITCH_MARGIN = 2; // 新しい方位の未踏セル数が現在の提案より何件以上多ければ切り替えるか（僅差ならちらつき防止のため維持）

// 冒険プリセット: 時間は厳密なタイマーではなく「新しく開放するセル数」の目安として使う。
// 値を変えたい場合はここだけ調整すればよい。
const ADVENTURE_PRESETS = {
  short: { minutes: 5, targetCells: 2 },
  normal: { minutes: 15, targetCells: 5 },
  long: { minutes: 30, targetCells: 8 },
};
const ADVENTURE_PRESET_ORDER = ["short", "normal", "long"];

// 発見数の節目（累計開放セル数）と演出メッセージ
const MILESTONE_THRESHOLDS = [1, 5, 10, 25, 50, 100];
const MILESTONE_MESSAGES = {
  1: "最初の場所を発見しました。",
  5: "街が少し広がりました。",
  10: "知らない道を、正解にしています。",
  25: "いつもの街に、知らない景色が増えました。",
  50: "この街の冒険家になってきました。",
  100: "歩いた分だけ、自分の街になりました。",
};

// 冒険完了時の一行メッセージ（ランダムに1件選ぶ）
const COMPLETION_MESSAGES = [
  "一本違うだけで、街は少し違って見えます。",
  "今日の寄り道も、正解でした。",
  "またこの街が、少し広くなりました。",
  "知らなかった場所が、今日の景色になりました。",
  "歩いた分だけ、自分の街になっていきます。",
  "次の発見は、一本隣の道にあるかもしれません。",
];

// 夜間セーフティ: 端末のローカル時刻ベース（18:00〜翌5:59を夜間とする）
const NIGHT_START_HOUR = 18;
const NIGHT_END_HOUR = 6; // この時刻未満は夜間

// 道路標識（方向決定UI）: はじく強さ→回転量の変換や最低保証回転数
const SIGN_MIN_ROTATIONS = 2;
const SIGN_MAX_ROTATIONS = 6;
const SIGN_VELOCITY_TO_ROTATIONS = 900; // deg/s あたりの回転数換算スケール
const SIGN_OVERSHOOT_DEG = 14; // 停止直前の小さなオーバーシュート量
// 方角の重み付け: index=フロンティア方位からの円環距離(0=最優先,4=反対)
const DIRECTION_WEIGHT_BY_DISTANCE = [10, 5, 2, 1, 1];

const STORAGE_KEYS = {
  origin: "am_origin",
  visited: "am_visited",
  quest: "am_quest",
  log: "am_log",
  milestones: "am_milestones",
  privacyAck: "am_share_privacy_ack",
};

// 共有カードのシルエット表示: グリッド1マスあたりの最大/最小ピクセル数
const SHAPE_GRID_MAX_PX = 220;
const SHAPE_GRID_MAX_CELL_PX = 34;
const SHAPE_GRID_MIN_CELL_PX = 14;

/* ---------- ローカルストレージ ヘルパー ---------- */
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
};

let origin = store.get(STORAGE_KEYS.origin, null); // {lat0, lon0}
let visited = store.get(STORAGE_KEYS.visited, {});  // { "ix_iy": {ts,lat,lon} }
let quest = store.get(STORAGE_KEYS.quest, null);    // {ix, iy, gradient, lat, lon}
let log = store.get(STORAGE_KEYS.log, []);          // [{ts, type, label}]

/* ---------- 座標・グリッド変換 ---------- */
const M_PER_DEG_LAT = 111320;

function mPerDegLon(lat0) {
  return 111320 * Math.cos((lat0 * Math.PI) / 180);
}

function toMeters(lat, lon) {
  return {
    x: (lon - origin.lon0) * mPerDegLon(origin.lat0),
    y: (lat - origin.lat0) * M_PER_DEG_LAT,
  };
}

function toLatLon(x, y) {
  return {
    lat: origin.lat0 + y / M_PER_DEG_LAT,
    lon: origin.lon0 + x / mPerDegLon(origin.lat0),
  };
}

function cellIndex(lat, lon) {
  const { x, y } = toMeters(lat, lon);
  return {
    ix: Math.floor(x / CELL_SIZE_M),
    iy: Math.floor(y / CELL_SIZE_M),
  };
}

function cellKey(ix, iy) {
  return `${ix}_${iy}`;
}

function cellCenterLatLon(ix, iy) {
  const cx = ix * CELL_SIZE_M + CELL_SIZE_M / 2;
  const cy = iy * CELL_SIZE_M + CELL_SIZE_M / 2;
  return toLatLon(cx, cy);
}

function cellBoundsLatLon(ix, iy) {
  const sw = toLatLon(ix * CELL_SIZE_M, iy * CELL_SIZE_M);
  const ne = toLatLon((ix + 1) * CELL_SIZE_M, (iy + 1) * CELL_SIZE_M);
  return [
    [sw.lat, sw.lon],
    [ne.lat, ne.lon],
  ];
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ---------- 地図 ---------- */
let map, cellsLayer, questLayer, meMarker;

function initMap(lat, lon) {
  map = L.map("map", { zoomControl: false, attributionControl: false }).setView(
    [lat, lon],
    17
  );
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  L.control.attribution({ prefix: false, position: "bottomleft" }).addTo(map);

  cellsLayer = L.layerGroup().addTo(map);
  questLayer = L.layerGroup().addTo(map);

  meMarker = L.circleMarker([lat, lon], {
    radius: 7,
    color: "#f59e0b",
    fillColor: "#f59e0b",
    fillOpacity: 1,
    weight: 2,
  }).addTo(map);

  // 既に保存済みのセルを再描画（1件でも壊れたデータがあっても地図初期化全体を止めない）
  Object.keys(visited).forEach((key) => {
    try {
      const [ix, iy] = key.split("_").map(Number);
      drawVisitedCell(ix, iy);
    } catch (e) {
      console.error("failed to restore visited cell", key, e);
    }
  });

  if (quest) {
    try {
      drawQuestMarker(quest);
    } catch (e) {
      console.error("failed to restore quest marker", e);
    }
  }
}

function drawVisitedCell(ix, iy, opts) {
  const animate = !!(opts && opts.animate) && !prefersReducedMotion();
  const rect = L.rectangle(cellBoundsLatLon(ix, iy), {
    className: "cell-rect",
    color: "#f59e0b",
    weight: 1,
    fillColor: "#f59e0b",
    fillOpacity: animate ? 0 : 0.28,
    opacity: animate ? 0 : 1,
  }).addTo(cellsLayer);

  if (animate) {
    requestAnimationFrame(() => {
      rect.setStyle({ fillOpacity: 0.28, opacity: 1 });
    });
  }
  return rect;
}

function drawQuestMarker(q) {
  questLayer.clearLayers();
  const icon = L.divIcon({
    className: "quest-flag-icon",
    html: "🚩",
    iconSize: [24, 24],
  });
  const marker = L.marker([q.lat, q.lon], { icon }).addTo(questLayer);
  marker.on("click", () => openQuestPanel());
}

/* ---------- HUD / パネル操作 ---------- */
const el = (id) => document.getElementById(id);

function updateHud(currentLat, currentLon) {
  el("stat-cells").textContent = Object.keys(visited).length;
  if (quest) {
    const d = Math.round(haversineMeters(currentLat, currentLon, quest.lat, quest.lon));
    el("stat-quest").textContent = `${d}m`;
  } else {
    el("stat-quest").textContent = "--";
  }
}

function showToast(msg, variant) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  t.classList.toggle("toast-milestone", variant === "milestone");
  clearTimeout(showToast._timer);
  const duration = variant === "milestone" ? 3400 : 2600;
  showToast._timer = setTimeout(() => t.classList.add("hidden"), duration);
}

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

function openQuestPanel() {
  el("quest-panel").classList.remove("hidden");
  if (quest) {
    el("quest-desc").textContent = "近くの坂・段差候補。到達すると開放されます。";
    el("quest-gradient").textContent =
      quest.gradientPct != null ? `勾配目安 ${quest.gradientPct}%` : "勾配 不明";
  } else {
    el("quest-desc").textContent = "周辺を探索するとクエストが見つかります。";
    el("quest-gradient").textContent = "";
  }
}

/* ---------- 発見ログ ---------- */
function pushLog(type, label) {
  log.unshift({ ts: Date.now(), type, label });
  log = log.slice(0, 100);
  store.set(STORAGE_KEYS.log, log);
  renderLog();
}

function renderLog() {
  const list = el("log-list");
  list.innerHTML = "";
  log.slice(0, 30).forEach((item) => {
    const li = document.createElement("li");
    const d = new Date(item.ts);
    const time = `${d.getMonth() + 1}/${d.getDate()} ${d
      .getHours()
      .toString()
      .padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    li.innerHTML = `<span>${item.label}</span><span class="tag">${time}</span>`;
    list.appendChild(li);
  });
}

/* ---------- 勾配クエスト生成 ---------- */
async function fetchElevations(points) {
  // points: [{latitude, longitude}, ...]
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ELEVATION_TIMEOUT_MS);
  try {
    const res = await fetch(ELEVATION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locations: points }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error("elevation api error");
    const data = await res.json();
    return data.results.map((r) => r.elevation);
  } finally {
    clearTimeout(timer);
  }
}

async function generateQuest(curLat, curLon) {
  const { ix: cix, iy: ciy } = cellIndex(curLat, curLon);

  const candidates = [];
  for (let dx = -QUEST_RING_CELLS; dx <= QUEST_RING_CELLS; dx++) {
    for (let dy = -QUEST_RING_CELLS; dy <= QUEST_RING_CELLS; dy++) {
      if (dx === 0 && dy === 0) continue;
      const ix = cix + dx;
      const iy = ciy + dy;
      if (visited[cellKey(ix, iy)]) continue;
      const c = cellCenterLatLon(ix, iy);
      const dist = haversineMeters(curLat, curLon, c.lat, c.lon);
      candidates.push({ ix, iy, lat: c.lat, lon: c.lon, dist });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.dist - b.dist);
  const shortlist = candidates.slice(0, MAX_QUEST_CANDIDATES);

  try {
    const points = [
      { latitude: curLat, longitude: curLon },
      ...shortlist.map((c) => ({ latitude: c.lat, longitude: c.lon })),
    ];
    const elevations = await fetchElevations(points);
    const curElev = elevations[0];

    shortlist.forEach((c, i) => {
      const elev = elevations[i + 1];
      const gradient = Math.abs(elev - curElev) / Math.max(c.dist, 1);
      c.gradientPct = Math.round(gradient * 100 * 10) / 10;
    });

    shortlist.sort((a, b) => b.gradientPct - a.gradientPct);
    return shortlist[0];
  } catch (e) {
    // 標高APIが失敗した場合は距離最短の候補をフォールバックにする
    return { ...shortlist[0], gradientPct: null };
  }
}

async function ensureQuest(curLat, curLon) {
  if (quest) return;
  const picked = await generateQuest(curLat, curLon);
  if (!picked) return;
  quest = picked;
  store.set(STORAGE_KEYS.quest, quest);
  drawQuestMarker(quest);
  updateHud(curLat, curLon);
}

/* ---------- フロンティア・コンパス ----------
   継続監視なし・追加API呼び出しなしで、現在地周辺(QUEST_RING_CELLS圏内)の
   未踏セルがどの方位に偏っているかを1本の矢印で示す表示専用機能。
   既存のセル管理・クエスト生成ロジックには一切影響しない。 */
function computeFrontierDirection(curLat, curLon, previousSector) {
  if (!origin) return { hasFrontier: false };

  const { ix: cix, iy: ciy } = cellIndex(curLat, curLon);
  const curXY = toMeters(curLat, curLon);

  const counts = new Array(8).fill(0);
  const nearestDistBySector = new Array(8).fill(Infinity);
  let totalUnvisited = 0;

  // generateQuest()と同じ近傍(正方形リング, QUEST_RING_CELLS)を走査対象にする
  for (let dx = -QUEST_RING_CELLS; dx <= QUEST_RING_CELLS; dx++) {
    for (let dy = -QUEST_RING_CELLS; dy <= QUEST_RING_CELLS; dy++) {
      if (dx === 0 && dy === 0) continue;
      const ix = cix + dx;
      const iy = ciy + dy;
      if (visited[cellKey(ix, iy)]) continue;

      const c = cellCenterLatLon(ix, iy);
      const cXY = toMeters(c.lat, c.lon);
      const bearingDeg =
        (Math.atan2(cXY.x - curXY.x, cXY.y - curXY.y) * 180 / Math.PI + 360) % 360;
      const sector = Math.round(bearingDeg / 45) % 8;
      const dist = haversineMeters(curLat, curLon, c.lat, c.lon);

      counts[sector]++;
      totalUnvisited++;
      if (dist < nearestDistBySector[sector]) nearestDistBySector[sector] = dist;
    }
  }

  if (totalUnvisited === 0) {
    return { hasFrontier: false };
  }

  const maxCount = Math.max(...counts);
  let bestSector = -1;
  let bestDist = Infinity;
  counts.forEach((count, sector) => {
    if (count !== maxCount) return;
    // 同数タイの場合は、最も近い未踏セルを含む方位を優先する
    if (nearestDistBySector[sector] < bestDist) {
      bestDist = nearestDistBySector[sector];
      bestSector = sector;
    }
  });

  // ちらつき防止: 現在提案中の方位がまだ有効（未踏セルが残っている）で、
  // 新しい最有力方位との差がFRONTIER_SWITCH_MARGIN未満（僅差）なら、方位を切り替えない。
  let chosenSector = bestSector;
  if (
    previousSector != null &&
    previousSector !== bestSector &&
    counts[previousSector] > 0 &&
    maxCount - counts[previousSector] < FRONTIER_SWITCH_MARGIN
  ) {
    chosenSector = previousSector;
  }

  return {
    hasFrontier: true,
    sector: chosenSector,
    count: counts[chosenSector],
    label: COMPASS_LABELS[chosenSector],
    bearingDeg: chosenSector * 45,
  };
}

// 表示状態: 'expanded'（矢印+ラベル+閉じるボタン）/ 'collapsed'（矢印アイコンのみ）/
// 'hidden-this-session'（×で閉じた。今回のセッション中のみ非表示。リロードで自動的にexpandedへ戻る）
let compassState = "expanded";
let compassResult = null;          // 直近のcomputeFrontierDirection()の結果
let lastCompassCheckLatLon = null; // 最後に方位を再計算した地点（100m移動判定の基準）
let compassMoveBaseLatLon = null;  // 累積移動距離を測るための直近地点（30m縮小判定の基準）
let compassMoveAccumM = 0;         // 縮小判定用の累積移動距離
let lastKnownLatLon = null;        // タップで再展開した際に即座に再計算するための直近位置

function recomputeCompass(lat, lon) {
  const prevSector = compassResult && compassResult.hasFrontier ? compassResult.sector : null;
  compassResult = computeFrontierDirection(lat, lon, prevSector);
  lastCompassCheckLatLon = { lat, lon };
  renderCompass();
}

function renderCompass() {
  const wrap = el("frontier-compass");
  const arrow = el("frontier-arrow");
  const label = el("frontier-label");
  const closeBtn = el("frontier-close");

  if (compassState === "hidden-this-session") {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  wrap.classList.toggle("collapsed", compassState === "collapsed");

  const hasFrontier = !!(compassResult && compassResult.hasFrontier);

  if (compassState === "collapsed") {
    label.classList.add("hidden");
    closeBtn.classList.add("hidden");
    arrow.classList.toggle("hidden", !hasFrontier);
    if (hasFrontier) arrow.style.transform = `rotate(${compassResult.bearingDeg}deg)`;
    return;
  }

  // expanded
  label.classList.remove("hidden");
  closeBtn.classList.remove("hidden");

  if (!hasFrontier) {
    arrow.classList.add("hidden");
    label.textContent = "このエリアはほぼ探索済み";
    return;
  }

  arrow.classList.remove("hidden");
  arrow.style.transform = `rotate(${compassResult.bearingDeg}deg)`;
  label.textContent = `${compassResult.label}に未踏エリア多数`;
}

function expandCompass() {
  compassState = "expanded";
  compassMoveAccumM = 0;
  compassMoveBaseLatLon = lastKnownLatLon ? { ...lastKnownLatLon } : null;
  if (lastKnownLatLon) {
    recomputeCompass(lastKnownLatLon.lat, lastKnownLatLon.lon);
  } else {
    renderCompass();
  }
}

function hideCompassForSession() {
  compassState = "hidden-this-session";
  renderCompass();
}

// GPSノイズの影響を抑えるため、精度の粗い測位(reliable=false)は移動・再計算の判定に使わない。
function updateFrontierCompassFlow(lat, lon, reliable) {
  lastKnownLatLon = { lat, lon };
  if (compassState === "hidden-this-session" || !reliable) return;

  if (!compassMoveBaseLatLon) {
    compassMoveBaseLatLon = { lat, lon };
  } else if (compassState === "expanded") {
    compassMoveAccumM += haversineMeters(compassMoveBaseLatLon.lat, compassMoveBaseLatLon.lon, lat, lon);
    compassMoveBaseLatLon = { lat, lon };
    if (compassMoveAccumM >= FRONTIER_COLLAPSE_DISTANCE_M) {
      compassState = "collapsed";
      compassMoveAccumM = 0;
    }
  } else {
    compassMoveBaseLatLon = { lat, lon };
  }

  const needsRecompute =
    !lastCompassCheckLatLon ||
    haversineMeters(lastCompassCheckLatLon.lat, lastCompassCheckLatLon.lon, lat, lon) >=
      FRONTIER_RECOMPUTE_DISTANCE_M;

  if (needsRecompute) {
    recomputeCompass(lat, lon);
  } else {
    renderCompass();
  }
}

/* ==========================================================
   冒険セッション状態
   ========================================================== */
const adventureState = {
  status: "idle", // idle | choosingDuration | choosingDirection | active | completed
  preset: null,
  targetCells: 0,
  discoveredCells: 0,
  direction: null, // {sector, label, bearingDeg}
  startedAt: null,
  startLatLon: null, // 冒険開始地点（帰り道用）
  targetReached: false,
  sessionDiscoveredCellIds: [], // 今回のセッションで新規開放したセル {ix,iy}（共有カードのシルエット表示専用。重複追加はしない）
};

function renderAdventureUI() {
  const s = adventureState.status;
  el("duration-panel").classList.toggle("hidden", s !== "choosingDuration");
  el("direction-panel").classList.toggle("hidden", s !== "choosingDirection");
  el("adventure-hud").classList.toggle("hidden", s !== "active");
  el("completion-sheet").classList.toggle("hidden", s !== "completed");
  el("btn-begin-adventure").classList.toggle("hidden", !(s === "idle" || s === "completed"));
}

function setAdventureStatus(status) {
  adventureState.status = status;
  renderAdventureUI();
}

function resetAdventureStateKeepHistory() {
  adventureState.preset = null;
  adventureState.targetCells = 0;
  adventureState.discoveredCells = 0;
  adventureState.direction = null;
  adventureState.startedAt = null;
  adventureState.startLatLon = null;
  adventureState.targetReached = false;
  adventureState.sessionDiscoveredCellIds = [];
}

function renderAdventureHud() {
  if (!adventureState.direction) return;
  el("adventure-hud-direction").textContent = `${adventureState.direction.label}へ冒険中`;
  el("adventure-hud-progress").textContent =
    `新しい場所 ${adventureState.discoveredCells} / ${adventureState.targetCells}`;
}

// アプリ起動後、初回の位置取得・地図準備が完了した直後に一度だけ呼ばれる（handlePosition内）。
// それ以外に、地図画面の「冒険開始」ボタンからも同じ入口を使う。
function beginAdventureFlow() {
  if (adventureState.status !== "idle" && adventureState.status !== "completed") return;
  if (isNightTime()) {
    showNightWarning();
  } else {
    showDurationPanel({ nightRestricted: false });
  }
}

function endAdventure() {
  if (adventureState.status !== "active") return;
  setAdventureStatus("completed");
  showCompletionSheet();
}

/* ---------- 夜間セーフティ ----------
   将来、緯度経度から日没時刻を算出できるよう判定はisNightTime()にまとめる。
   現状は端末のローカル時刻のみを使用（外部の日没API等は導入しない）。 */
function isNightTime(date) {
  const d = date || new Date();
  const h = d.getHours();
  return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
}

function showNightWarning() {
  const panel = el("night-warning-panel");
  panel.classList.remove("hidden");
  const firstBtn = panel.querySelector("button");
  if (firstBtn) firstBtn.focus();
}

function hideNightWarning() {
  el("night-warning-panel").classList.add("hidden");
}

/* ---------- 冒険時間選択 ---------- */
function renderDurationOptions() {
  ADVENTURE_PRESET_ORDER.forEach((key) => {
    const preset = ADVENTURE_PRESETS[key];
    const btn = document.querySelector(`.duration-option[data-preset="${key}"]`);
    if (!btn) return;
    btn.querySelector(".duration-minutes").textContent = `${preset.minutes}分`;
    btn.querySelector(".duration-desc").textContent = `新しい場所を${preset.targetCells}つ`;
  });
}

function showDurationPanel(opts) {
  const nightRestricted = !!(opts && opts.nightRestricted) || isNightTime();
  el("duration-option-normal").classList.toggle("hidden", nightRestricted);
  el("duration-option-long").classList.toggle("hidden", nightRestricted);
  setAdventureStatus("choosingDuration");
  const firstVisible = document.querySelector(".duration-option:not(.hidden)");
  if (firstVisible) firstVisible.focus();
}

function selectAdventurePreset(presetKey) {
  const preset = ADVENTURE_PRESETS[presetKey];
  if (!preset) return;
  adventureState.preset = presetKey;
  adventureState.targetCells = preset.targetCells;
  adventureState.discoveredCells = 0;
  adventureState.targetReached = false;
  showDirectionPanel();
}

/* ---------- 道路標識・方向決定UI ----------
   フロンティア・コンパスの方位判定ロジック(computeFrontierDirection)を
   そのまま流用し、優先方向を中心に揺らぎを持たせた重み付き抽選で方角を選ぶ。 */
let signSpinning = false;
let signDragState = null;
let currentSignRotation = 0;
let signAnimationFrameId = null;

function pickWeightedDirectionSector(frontierResult) {
  const hasFrontier = frontierResult && frontierResult.hasFrontier;
  const weights = [];
  for (let s = 0; s < 8; s++) {
    if (!hasFrontier) {
      weights.push(1); // 未踏エリアの偏りが無ければ均等ランダム
      continue;
    }
    const raw = Math.abs(s - frontierResult.sector);
    const dist = Math.min(raw, 8 - raw);
    weights.push(DIRECTION_WEIGHT_BY_DISTANCE[dist]);
  }
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let s = 0; s < 8; s++) {
    r -= weights[s];
    if (r <= 0) return s;
  }
  return 0;
}

function getSignBoardCenter() {
  const rect = el("sign-board").getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function angleFromCenter(clientX, clientY, center) {
  return (Math.atan2(clientY - center.y, clientX - center.x) * 180) / Math.PI;
}

function normalizeAngleDelta(delta) {
  let d = delta % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function applySignRotation(deg) {
  el("sign-board").style.transform = `rotate(${deg}deg)`;
}

function cancelSignAnimation() {
  if (signAnimationFrameId != null) {
    cancelAnimationFrame(signAnimationFrameId);
    signAnimationFrameId = null;
  }
  signSpinning = false;
}

function computeFinalRotation(current, targetBearingDeg, spinSign, rotations) {
  const currentMod = ((current % 360) + 360) % 360;
  const deltaCW = (targetBearingDeg - currentMod + 360) % 360;
  const delta = spinSign >= 0 ? deltaCW : deltaCW === 0 ? 0 : deltaCW - 360;
  return current + spinSign * rotations * 360 + delta;
}

function onSignPointerDown(e) {
  if (signSpinning) return;
  cancelSignAnimation();
  const board = el("sign-board");
  try {
    board.setPointerCapture(e.pointerId);
  } catch (err) {
    // ポインターキャプチャ非対応でも操作自体は継続する
  }
  const center = getSignBoardCenter();
  const angle = angleFromCenter(e.clientX, e.clientY, center);
  signDragState = {
    center,
    lastAngle: angle,
    cumulativeDelta: 0,
    startRotation: currentSignRotation,
    history: [{ t: performance.now(), rotation: currentSignRotation }],
  };
  board.classList.add("dragging");
}

function onSignPointerMove(e) {
  if (!signDragState) return;
  const angle = angleFromCenter(e.clientX, e.clientY, signDragState.center);
  const delta = normalizeAngleDelta(angle - signDragState.lastAngle);
  signDragState.lastAngle = angle;
  signDragState.cumulativeDelta += delta;
  currentSignRotation = signDragState.startRotation + signDragState.cumulativeDelta;
  applySignRotation(currentSignRotation);
  const now = performance.now();
  signDragState.history.push({ t: now, rotation: currentSignRotation });
  while (signDragState.history.length > 2 && now - signDragState.history[0].t > 200) {
    signDragState.history.shift();
  }
}

function onSignPointerUp(e) {
  if (!signDragState) return;
  const board = el("sign-board");
  try {
    board.releasePointerCapture(e.pointerId);
  } catch (err) {
    // 無視して継続
  }
  board.classList.remove("dragging");
  const history = signDragState.history;
  const first = history[0];
  const last = history[history.length - 1];
  const dt = last.t - first.t;
  const velocityDegPerMs = dt > 8 ? (last.rotation - first.rotation) / dt : 0;
  signDragState = null;
  triggerSignSpin({ velocityDegPerSec: velocityDegPerMs * 1000 });
}

function triggerSignSpin(opts) {
  if (signSpinning) return;
  const refLatLon = lastKnownLatLon || (origin ? { lat: origin.lat0, lon: origin.lon0 } : null);
  const frontier = refLatLon
    ? compassResult && compassResult.hasFrontier
      ? compassResult
      : computeFrontierDirection(refLatLon.lat, refLatLon.lon)
    : { hasFrontier: false };
  const targetSector = pickWeightedDirectionSector(frontier);

  const v = opts && opts.velocityDegPerSec != null ? opts.velocityDegPerSec : 0;
  const spinSign = v !== 0 ? Math.sign(v) : Math.random() < 0.5 ? -1 : 1;
  const absV = Math.abs(v);
  let rotations = Math.round(absV / SIGN_VELOCITY_TO_ROTATIONS);
  rotations = Math.max(SIGN_MIN_ROTATIONS, Math.min(SIGN_MAX_ROTATIONS, rotations || SIGN_MIN_ROTATIONS));

  animateSignSpin(targetSector, spinSign, rotations);
}

function animateSignSpin(targetSector, spinSign, rotations) {
  const targetBearingDeg = targetSector * 45;
  const startRotation = currentSignRotation;
  const finalRotation = computeFinalRotation(startRotation, targetBearingDeg, spinSign, rotations);
  const reducedMotion = prefersReducedMotion();

  signSpinning = true;
  el("sign-board").classList.add("spinning");

  if (reducedMotion) {
    currentSignRotation = finalRotation;
    applySignRotation(currentSignRotation);
    setTimeout(() => {
      signSpinning = false;
      el("sign-board").classList.remove("spinning");
      onSignSettled(targetSector);
    }, 260);
    return;
  }

  const overshoot = spinSign * SIGN_OVERSHOOT_DEG;
  const overshootRotation = finalRotation + overshoot;
  const duration = Math.max(700, Math.min(3200, rotations * 260 + 500));
  const settleDuration = 260;
  const startTime = performance.now();

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function step(now) {
    const elapsed = now - startTime;
    if (elapsed < duration) {
      const t = elapsed / duration;
      currentSignRotation = startRotation + (overshootRotation - startRotation) * easeOutCubic(t);
      applySignRotation(currentSignRotation);
      signAnimationFrameId = requestAnimationFrame(step);
      return;
    }
    const settleElapsed = elapsed - duration;
    if (settleElapsed < settleDuration) {
      const t = settleElapsed / settleDuration;
      const wobble = Math.sin(t * Math.PI * 2.5) * SIGN_OVERSHOOT_DEG * 0.5 * (1 - t);
      currentSignRotation = overshootRotation + (finalRotation - overshootRotation) * t + wobble;
      applySignRotation(currentSignRotation);
      signAnimationFrameId = requestAnimationFrame(step);
      return;
    }
    currentSignRotation = finalRotation;
    applySignRotation(currentSignRotation);
    signSpinning = false;
    el("sign-board").classList.remove("spinning");
    signAnimationFrameId = null;
    onSignSettled(targetSector);
  }

  signAnimationFrameId = requestAnimationFrame(step);
}

function onSignSettled(sector) {
  const label = COMPASS_LABELS[sector];
  adventureState.direction = { sector, label, bearingDeg: sector * 45 };
  el("direction-result-text").textContent = `今日は${label}へ。`;
  el("direction-result-sub").textContent = "最初の200〜300mだけ、この方向を意識してみよう。";
  el("direction-result").classList.remove("hidden");
  // #sign-boardはaria-hiddenな視覚要素なので、読み上げ用にsr-onlyのライブリージョンへ結果を通知する。
  el("sign-sr-status").textContent = `方角が決まりました。今日は${label}へ。`;
  const confirmBtn = el("btn-confirm-direction");
  if (confirmBtn) confirmBtn.focus();
}

function showDirectionPanel() {
  setAdventureStatus("choosingDirection");
  el("direction-result").classList.add("hidden");
  el("direction-hint").textContent = isNightTime()
    ? "明るく、人通りのある道を選んでください。標識をはじいて方角を決めよう。"
    : "標識をはじいて、今日進む方角を決めよう。";
  el("sign-sr-status").textContent = "まだ方角は決まっていません。標識を回すボタンで方角を決められます。";
}

function redoDirection() {
  el("direction-result").classList.add("hidden");
  adventureState.direction = null;
  el("sign-sr-status").textContent = "方角をやり直します。もう一度、標識を回すボタンを押してください。";
  const spinBtn = el("btn-spin-sign");
  if (spinBtn) spinBtn.focus();
}

function confirmDirection() {
  if (!adventureState.direction) return;
  adventureState.startedAt = Date.now();
  adventureState.startLatLon = lastKnownLatLon ? { ...lastKnownLatLon } : null;
  adventureState.sessionDiscoveredCellIds = [];
  compassState = "collapsed";
  renderCompass();
  setAdventureStatus("active");
  renderAdventureHud();
  showToast(`${adventureState.direction.label}へ冒険開始！`);
}

/* ---------- セル発見リアクション ----------
   将来SEを追加しやすいよう、視覚・文言・振動のリアクションを一箇所にまとめる。 */
function handleCellDiscoveryFeedback(ix, iy) {
  drawVisitedCell(ix, iy, { animate: true });
  showToast("新しい場所を発見！");
  pushLog("cell", `セル開放 (${ix},${iy})`);

  try {
    if ("vibrate" in navigator) navigator.vibrate(30);
  } catch (e) {
    // 振動非対応・失敗しても本体は継続する
  }

  if (adventureState.status === "active") {
    adventureState.discoveredCells++;
    const alreadyTracked = adventureState.sessionDiscoveredCellIds.some(
      (c) => c.ix === ix && c.iy === iy
    );
    if (!alreadyTracked) {
      adventureState.sessionDiscoveredCellIds.push({ ix, iy });
    }
    renderAdventureHud();
    if (!adventureState.targetReached && adventureState.discoveredCells >= adventureState.targetCells) {
      adventureState.targetReached = true;
      setTimeout(() => showToast("今日の冒険を達成しました！"), 900);
    }
  }
}

/* ---------- 発見数の節目 ---------- */
function checkMilestones() {
  try {
    const total = Object.keys(visited).length;
    const displayed = store.get(STORAGE_KEYS.milestones, []);
    const newlyReached = MILESTONE_THRESHOLDS.filter((t) => total >= t && !displayed.includes(t));
    if (newlyReached.length === 0) return;
    const toCelebrate = newlyReached[newlyReached.length - 1];
    store.set(STORAGE_KEYS.milestones, [...displayed, ...newlyReached]);
    showMilestoneCelebration(toCelebrate);
  } catch (e) {
    // 節目演出に失敗してもアプリ本体は継続する
  }
}

function showMilestoneCelebration(threshold) {
  const msg = MILESTONE_MESSAGES[threshold] || "新しい節目に到達しました。";
  showToast(msg, "milestone");
  pushLog("milestone", msg);
  try {
    spawnConfetti();
  } catch (e) {
    // 紙吹雪の失敗は無視して継続する
  }
}

function spawnConfetti() {
  if (prefersReducedMotion()) return;
  const layer = el("confetti-layer");
  if (!layer) return;
  const colors = ["#f59e0b", "#fbbf24", "#facc15", "#e5e7eb", "#60a5fa"];
  const count = 18;
  for (let i = 0; i < count; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 150}ms`;
    piece.style.setProperty("--drift", `${(Math.random() - 0.5) * 120}px`);
    piece.style.setProperty("--rot", `${(Math.random() - 0.5) * 720}deg`);
    layer.appendChild(piece);
    setTimeout(() => piece.remove(), 1500);
  }
}

/* ---------- 冒険完了シート ---------- */
let lastCompletionMessage = ""; // 成果カードでも同じ一行メッセージを使い回すため保持

function showCompletionSheet() {
  const preset = adventureState.preset ? ADVENTURE_PRESETS[adventureState.preset] : null;
  el("completion-duration").textContent = preset ? `${preset.minutes}分` : "--";
  el("completion-direction").textContent = adventureState.direction ? adventureState.direction.label : "--";
  el("completion-session-cells").textContent = `${adventureState.discoveredCells}`;
  el("completion-total-cells").textContent = `${Object.keys(visited).length}`;
  lastCompletionMessage = COMPLETION_MESSAGES[Math.floor(Math.random() * COMPLETION_MESSAGES.length)];
  el("completion-message").textContent = lastCompletionMessage;
  const firstBtn = el("completion-sheet").querySelector("button");
  if (firstBtn) firstBtn.focus();
}

function openWayHome() {
  try {
    if (!adventureState.startLatLon) {
      showToast("開始地点の記録がありません");
      return;
    }
    const dest = `${adventureState.startLatLon.lat},${adventureState.startLatLon.lon}`;
    let url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=walking`;
    if (lastKnownLatLon) {
      const originParam = `${lastKnownLatLon.lat},${lastKnownLatLon.lon}`;
      url += `&origin=${encodeURIComponent(originParam)}`;
    }
    window.open(url, "_blank", "noopener");
  } catch (e) {
    showToast("帰り道を開けませんでした");
  }
}

function continueAdventure() {
  el("completion-sheet").classList.add("hidden");
  resetAdventureStateKeepHistory();
  setAdventureStatus("idle");
  beginAdventureFlow();
}

function finishToday() {
  resetAdventureStateKeepHistory();
  setAdventureStatus("idle");
}

/* ==========================================================
   共有カード（プライバシーを守ったスクリーンショット用表示）
   現在地・緯度経度・地図・道路名・開始/終了地点など、生活圏を推測できる
   情報は一切表示しない。地図タイルも読み込まない完全に独立したオーバーレイ。
   ========================================================== */
const SHARE_CARD_BG_IDS = ["hud", "frontier-compass", "adventure-hud", "map"];
// 共有カードは他のパネルの上に不透明で重なるため、判定順は必ずカードを先にする
// （背景の親パネルはカード表示中も非表示化していないため、配列順が優先度になる）。
const FOCUS_TRAP_CONTAINER_IDS = [
  "direction-card",
  "achievement-card",
  "night-warning-panel",
  "duration-panel",
  "direction-panel",
  "completion-sheet",
];
let shareCardReturnFocusEl = null;

function getFocusableElements(container) {
  const nodes = container.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  return Array.from(nodes).filter((n) => !n.disabled && n.offsetParent !== null);
}

function getOpenModalContainer() {
  for (const id of FOCUS_TRAP_CONTAINER_IDS) {
    const elm = el(id);
    if (elm && !elm.classList.contains("hidden")) return elm;
  }
  return null;
}

// 主要モーダル・共有カード共通の簡易フォーカストラップ + 共有カードのみEscapeで閉じる
function handleGlobalModalKeydown(e) {
  const container = getOpenModalContainer();
  if (!container) return;

  if (e.key === "Tab") {
    const focusables = getFocusableElements(container);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  } else if (e.key === "Escape" && (container.id === "direction-card" || container.id === "achievement-card")) {
    e.preventDefault();
    closeShareCard(container.id);
  }
}

function openShareCard(cardId) {
  shareCardReturnFocusEl = document.activeElement;
  SHARE_CARD_BG_IDS.forEach((id) => {
    const bgEl = document.getElementById(id);
    if (bgEl) bgEl.setAttribute("aria-hidden", "true");
  });
  const card = el(cardId);
  card.classList.remove("hidden");
  const focusables = getFocusableElements(card);
  if (focusables.length > 0) focusables[0].focus();
}

function closeShareCard(cardId) {
  const card = el(cardId);
  card.classList.add("hidden");
  SHARE_CARD_BG_IDS.forEach((id) => {
    const bgEl = document.getElementById(id);
    if (bgEl) bgEl.removeAttribute("aria-hidden");
  });
  if (shareCardReturnFocusEl && typeof shareCardReturnFocusEl.focus === "function") {
    try {
      shareCardReturnFocusEl.focus();
    } catch (e) {
      // フォーカス対象が既にDOMから外れている場合は無視する
    }
  }
  shareCardReturnFocusEl = null;
}

/* ---------- Priority 1: 方向決定カード ---------- */
function showDirectionCard() {
  if (!adventureState.direction) return;
  el("share-sign-board").style.transform = `rotate(${adventureState.direction.bearingDeg}deg)`;
  el("direction-card-text").textContent = `今日は${adventureState.direction.label}へ。`;
  openShareCard("direction-card");
}

/* ---------- Priority 3: 今回歩いた形の匿名化 ----------
   実際の緯度経度・セルの絶対座標は一切表示しない。
   1) 最小X・最小Yを引いて原点へ移動
   2) 0/90/180/270度のいずれかをランダムに適用
   3) 再度、原点へ寄せて中央に収まる形だけを残す */
function rotatePointCW90(p) {
  return { x: -p.y, y: p.x };
}

function computeSessionShapeCells(cellIds) {
  if (!cellIds || cellIds.length === 0) return [];
  const minIx = Math.min(...cellIds.map((c) => c.ix));
  const minIy = Math.min(...cellIds.map((c) => c.iy));
  let points = cellIds.map((c) => ({ x: c.ix - minIx, y: c.iy - minIy }));

  const rotations = Math.floor(Math.random() * 4); // 0,1,2,3 → 0/90/180/270度
  for (let i = 0; i < rotations; i++) {
    points = points.map(rotatePointCW90);
  }

  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  return points.map((p) => ({ x: p.x - minX, y: p.y - minY }));
}

function renderShapeGrid(container, cellIds) {
  container.innerHTML = "";
  const cells = computeSessionShapeCells(cellIds);
  if (cells.length === 0) return;

  const width = Math.max(...cells.map((c) => c.x)) + 1;
  const height = Math.max(...cells.map((c) => c.y)) + 1;
  const cellPx = Math.max(
    SHAPE_GRID_MIN_CELL_PX,
    Math.min(SHAPE_GRID_MAX_CELL_PX, Math.floor(SHAPE_GRID_MAX_PX / Math.max(width, height)))
  );
  container.style.gridTemplateColumns = `repeat(${width}, ${cellPx}px)`;
  container.style.gridTemplateRows = `repeat(${height}, ${cellPx}px)`;

  cells.forEach((c) => {
    const sq = document.createElement("div");
    sq.className = "shape-cell";
    sq.style.gridColumn = `${c.x + 1}`;
    sq.style.gridRow = `${c.y + 1}`;
    container.appendChild(sq);
  });
}

/* ---------- Priority 2 + 4: 冒険成果カード ---------- */
function showAchievementCard() {
  el("achievement-cell-count").textContent = `${adventureState.sessionDiscoveredCellIds.length}`;
  const preset = adventureState.preset ? ADVENTURE_PRESETS[adventureState.preset] : null;
  el("achievement-duration").textContent = preset ? `${preset.minutes}分` : "--";
  el("achievement-direction").textContent = adventureState.direction ? adventureState.direction.label : "--";
  el("achievement-message").textContent = lastCompletionMessage;

  const notice = el("share-privacy-notice");
  const alreadyAcked = store.get(STORAGE_KEYS.privacyAck, false);
  notice.classList.toggle("hidden", !!alreadyAcked);
  if (!alreadyAcked) {
    try {
      store.set(STORAGE_KEYS.privacyAck, true);
    } catch (e) {
      // 保存に失敗しても表示自体は継続する
    }
  }

  try {
    renderShapeGrid(el("achievement-shape-grid"), adventureState.sessionDiscoveredCellIds);
  } catch (e) {
    // シルエット描画に失敗してもカード自体は表示する
  }

  openShareCard("achievement-card");
}

/* ---------- 位置情報の処理 ---------- */
let lastAccuracyWarnAt = 0;

function handlePosition(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;

  if (!origin) {
    origin = { lat0: lat, lon0: lon };
    store.set(STORAGE_KEYS.origin, origin);
  }

  if (!map) {
    try {
      initMap(lat, lon);
    } catch (e) {
      // 地図初期化の一部が失敗しても、以降の処理（冒険フロー開始など）は止めない。
      console.error("initMap failed", e);
      showToast("地図の初期化で問題が発生しました");
    }
    try {
      // 初回の位置取得・地図準備が完了した直後に、冒険時間選択へ自動で進む。
      beginAdventureFlow();
    } catch (e) {
      console.error("beginAdventureFlow failed", e);
      showToast("冒険の準備で問題が発生しました。再読み込みしてください。");
    }
  } else if (meMarker) {
    meMarker.setLatLng([lat, lon]);
  }
  hideLoading();

  // GPS精度が粗い（誤差が大きい）測位は、セル開放やクエスト達成の判定には使わない。
  // 位置表示・地図追従は行うが、誤ったセルを開放しないようにする。
  const reliable = accuracy == null || accuracy <= ACCURACY_OPEN_M;

  if (!reliable && accuracy != null && accuracy > ACCURACY_WARN_M) {
    const now = Date.now();
    if (now - lastAccuracyWarnAt > ACCURACY_WARN_INTERVAL_MS) {
      lastAccuracyWarnAt = now;
      showToast(`GPS精度が低いです（誤差約${Math.round(accuracy)}m）`);
    }
  }

  if (reliable) {
    const { ix, iy } = cellIndex(lat, lon);
    const key = cellKey(ix, iy);

    if (!visited[key]) {
      visited[key] = { ts: Date.now(), lat, lon };
      store.set(STORAGE_KEYS.visited, visited);
      handleCellDiscoveryFeedback(ix, iy);
      checkMilestones();
    }

    if (quest && quest.ix === ix && quest.iy === iy) {
      const g = quest.gradientPct != null ? `勾配目安${quest.gradientPct}%` : "";
      showToast(`クエスト達成！${g}`);
      pushLog("quest", `勾配クエスト達成 ${g}`);
      quest = null;
      store.set(STORAGE_KEYS.quest, null);
      questLayer.clearLayers();
    }
  }

  updateHud(lat, lon);
  updateFrontierCompassFlow(lat, lon, reliable);
  ensureQuest(lat, lon);
}

let geoRetried = false;

function handlePositionError(err) {
  console.error(err);
  hideLoading();

  if (!map) {
    // 初回の測位に失敗した場合、タイムアウトなら精度を下げて一度だけ再試行する。
    if (!geoRetried && err.code === err.TIMEOUT) {
      geoRetried = true;
      showToast("位置情報の取得に時間がかかっています。再試行します…");
      showLoading();
      navigator.geolocation.getCurrentPosition(handlePosition, handlePositionError, {
        enableHighAccuracy: false,
        timeout: 20000,
        maximumAge: 60000,
      });
      return;
    }
    // 再試行しても失敗、または権限拒否などの場合は開始画面に戻して再操作できるようにする。
    showRetryScreen(err);
    return;
  }

  showToast("位置情報を取得できませんでした");
}

/* ---------- 起動処理 ---------- */
function showLoading() {
  el("loading-overlay").classList.remove("hidden");
}

function hideLoading() {
  el("loading-overlay").classList.add("hidden");
}

function showRetryScreen(err) {
  const messages = {
    1: "位置情報の利用が許可されていません。ブラウザの設定から許可してください。", // PERMISSION_DENIED
    2: "現在地を取得できませんでした。電波状況の良い場所でお試しください。", // POSITION_UNAVAILABLE
    3: "現在地の取得がタイムアウトしました。もう一度お試しください。", // TIMEOUT
  };
  const errorEl = el("permission-error");
  errorEl.textContent = messages[err.code] || "現在地を取得できませんでした。もう一度お試しください。";
  errorEl.classList.remove("hidden");
  geoRetried = false;
  el("permission-screen").classList.remove("hidden");
}

function startTracking() {
  el("permission-screen").classList.add("hidden");
  el("permission-error").classList.add("hidden");
  if (!("geolocation" in navigator)) {
    showToast("この端末は位置情報に対応していません");
    return;
  }
  showLoading();
  navigator.geolocation.getCurrentPosition(handlePosition, handlePositionError, {
    enableHighAccuracy: true,
    timeout: 15000,
  });
  navigator.geolocation.watchPosition(handlePosition, handlePositionError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 20000,
  });
}

/* ---------- イベント配線 ---------- */
window.addEventListener("DOMContentLoaded", () => {
  renderLog();

  el("btn-start").addEventListener("click", startTracking);
  el("btn-log").addEventListener("click", () => el("log-panel").classList.remove("hidden"));
  el("btn-close-log").addEventListener("click", () => el("log-panel").classList.add("hidden"));
  el("btn-close-quest").addEventListener("click", () => el("quest-panel").classList.add("hidden"));

  // フロンティア・コンパス: 縮小時は本体タップで再展開、×は閉じるボタンのみで反応
  el("frontier-compass").addEventListener("click", () => {
    if (compassState === "collapsed") expandCompass();
  });
  el("frontier-close").addEventListener("click", (e) => {
    e.stopPropagation();
    hideCompassForSession();
  });

  // ---- 冒険セッション: 初期表示 ----
  renderDurationOptions();
  renderAdventureUI();

  // ---- 冒険時間選択 ----
  document.querySelectorAll(".duration-option").forEach((btn) => {
    btn.addEventListener("click", () => selectAdventurePreset(btn.dataset.preset));
  });

  // ---- 道路標識（方向決定） ----
  const signBoard = el("sign-board");
  signBoard.addEventListener("pointerdown", onSignPointerDown);
  signBoard.addEventListener("pointermove", onSignPointerMove);
  signBoard.addEventListener("pointerup", onSignPointerUp);
  signBoard.addEventListener("pointercancel", onSignPointerUp);
  el("btn-spin-sign").addEventListener("click", () => triggerSignSpin({ velocityDegPerSec: null }));
  el("btn-redo-direction").addEventListener("click", redoDirection);
  el("btn-confirm-direction").addEventListener("click", confirmDirection);

  // ---- 夜間セーフティ ----
  el("btn-night-cancel").addEventListener("click", () => {
    hideNightWarning();
    setAdventureStatus("idle");
  });
  el("btn-night-continue").addEventListener("click", () => {
    hideNightWarning();
    showDurationPanel({ nightRestricted: true });
  });

  // ---- 冒険開始・終了 ----
  el("btn-begin-adventure").addEventListener("click", beginAdventureFlow);
  el("btn-end-adventure").addEventListener("click", endAdventure);

  // ---- 冒険完了シート ----
  el("btn-open-way-home").addEventListener("click", openWayHome);
  el("btn-continue-adventure").addEventListener("click", continueAdventure);
  el("btn-finish-today").addEventListener("click", finishToday);

  // ---- 共有カード ----
  el("btn-show-direction-card").addEventListener("click", showDirectionCard);
  el("btn-close-direction-card").addEventListener("click", () => closeShareCard("direction-card"));
  el("btn-show-achievement-card").addEventListener("click", showAchievementCard);
  el("btn-close-achievement-card").addEventListener("click", () => closeShareCard("achievement-card"));
  el("btn-privacy-ack").addEventListener("click", () => {
    el("share-privacy-notice").classList.add("hidden");
  });
  document.addEventListener("keydown", handleGlobalModalKeydown);

  // 既に許可済みなら初期画面を出さずに即開始（Permissions APIが使える場合のみ）
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions
      .query({ name: "geolocation" })
      .then((status) => {
        if (status.state === "granted") startTracking();
      })
      .catch(() => {});
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
});
