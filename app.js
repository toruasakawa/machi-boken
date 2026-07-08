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

const STORAGE_KEYS = {
  origin: "am_origin",
  visited: "am_visited",
  quest: "am_quest",
  log: "am_log",
};

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

  // 既に保存済みのセルを再描画
  Object.keys(visited).forEach((key) => {
    const [ix, iy] = key.split("_").map(Number);
    drawVisitedCell(ix, iy);
  });

  if (quest) drawQuestMarker(quest);
}

function drawVisitedCell(ix, iy) {
  L.rectangle(cellBoundsLatLon(ix, iy), {
    color: "#f59e0b",
    weight: 1,
    fillColor: "#f59e0b",
    fillOpacity: 0.28,
  }).addTo(cellsLayer);
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

function showToast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add("hidden"), 2600);
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

/* ---------- 位置情報の処理 ---------- */
let lastAccuracyWarnAt = 0;

function handlePosition(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;

  if (!origin) {
    origin = { lat0: lat, lon0: lon };
    store.set(STORAGE_KEYS.origin, origin);
  }

  if (!map) {
    initMap(lat, lon);
  } else {
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
      drawVisitedCell(ix, iy);
      showToast("新しいセルを開放した");
      pushLog("cell", `セル開放 (${ix},${iy})`);
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
