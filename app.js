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
