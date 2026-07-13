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

// 方角の重み付け: index=フロンティア方位からの円環距離(0=最優先,4=反対)
const DIRECTION_WEIGHT_BY_DISTANCE = [10, 5, 2, 1, 1];

// 道路標識（方向決定UI）の物理定数。実機調整はこのオブジェクトだけで完結するようにする。
// 単位は角度=度(deg)、角速度=度/ミリ秒(deg/ms)で統一している。
const SIGN_PHYSICS = {
  historyWindowMs: 150,        // pointerup直前、角速度算出に使う履歴の時間窓
  minVelocitySampleDt: 8,      // 角速度算出に使う最古〜最新サンプルの最小間隔(ms未満は採用しない)
  tapMaxAngleDeg: 6,           // これ未満の正味移動量ならタップ候補
  tapMaxDurationMs: 250,       // これ未満の操作時間ならタップ候補
  minFlickVelocity: 0.06,      // これ未満の角速度(deg/ms)は事実上タップ扱い（フリックの下限でもある）
  maxInputVelocity: 1.6,       // 入力角速度(deg/ms)の実測上限の目安。これ以上はclampする
  minSpinVelocity: 3.9,        // 慣性回転の初速下限(deg/ms)（タップ以外の最弱フリック）
  maxSpinVelocity: 5.7,        // 慣性回転の初速上限(deg/ms)（最強フリック）
  velocityCurvePower: 0.7,     // 入力強度→初速・摩擦のカーブ指数(1未満で弱入力側の差を強調)
  // 摩擦は初速に応じて可変にする（強い入力ほど摩擦を弱めて長く/多く回るようにし、
  // 回転数と停止時間の両方が入力強度に連動して伸びるようにする）。
  frictionPerFrameAt60fpsMin: 0.878, // 最弱フリック時の摩擦係数（小さいほど速く減速）
  frictionPerFrameAt60fpsMax: 0.949, // 最強フリック時の摩擦係数（大きいほどゆっくり減速＝長く回る）
  snapVelocityThreshold: 0.02, // 角速度がこれ未満まで減衰したら吸着フェーズへ移行(deg/ms)
  overshootDeg: 4,             // 吸着直前の小さなオーバーシュート量(度)
  overshootDurationMs: 200,    // オーバーシュート角度までの所要時間
  settleBackDurationMs: 150,   // オーバーシュートから最終角度へ戻る所要時間
  maxSpinDurationMs: 2500,     // 慣性回転フェーズの最大許容時間（安全装置。これを超えたら強制的に吸着へ）
  tapSpinRotationRangeDeg: [90, 270], // タップ時の回転量の目安レンジ(度。0.25〜0.75回転相当)
  tapSpinDurationRangeMs: [500, 900], // タップ時の停止フェーズ所要時間の目安レンジ
  buttonSpinVelocity: 0.55,    // 「標識を回す」ボタン押下時に使う疑似入力速度(deg/ms、中程度のフリック相当)
};

const DEBUG_SIGN_PHYSICS = false; // trueにすると操作の計測値・分類・初速などをコンソールへ出力する

// pointerup直前のリリース角速度をどう算出するかの設定。
// 「最後だけ強くはじく」操作を、履歴全体の平均で薄めずに正しく拾うことが目的。
const SIGN_RELEASE_VELOCITY = {
  preferredWindowMs: 80,    // まずこの時間内(直近)のサンプルだけで速度を計算する
  fallbackWindowMs: 150,    // 直近サンプルが不十分なら、ここまで範囲を広げる
  minimumWindowMs: 24,      // これ未満の時間差では信頼できる速度が出せない
  minimumSampleCount: 3,    // 採用ウィンドウ内に必要な最小サンプル数
  recencyWeightPower: 2,    // 直近ほど重みを強める指数（大きいほど最新区間を強調）
  recencyWeightMax: 3,      // 直近区間に上乗せされる重みの最大値（基本重み1 + これ）
  maxSegmentVelocity: 50,   // 1区間の角速度がこれを超えたら明らかな外れ値として除外する(deg/ms)
  usePeakBlend: true,       // 加重平均だけでなく、直近ピーク速度も少量ブレンドするか
};
// 加重平均とピーク速度のブレンド比率（usePeakBlend時のみ使用）。
const RELEASE_VELOCITY_BLEND = {
  weightedAverageRatio: 0.75,
  recentPeakRatio: 0.25,
};

const DEBUG_SIGN_RELEASE_VELOCITY = false; // trueで1操作ごとにリリース速度の詳細計測値をコンソールへ出力する

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
   フロンティア・コンパスの方位判定ロジック(computeFrontierDirection)を再利用しつつ、
   回転そのものは pointerup 直前の実測角速度を初速とした摩擦(慣性)物理で駆動する。
   タップ/フリックの強弱が回転速度・回転数・停止時間へ連続的に反映されることが目的。 */
let signSpinning = false;
let signDragState = null;   // {center, lastAngle, cumulativeDelta, startRotation, downTime, browserEventCount, coalescedSampleCount, history:[{angle,timestamp}]}
let currentSignRotation = 0;
let signAnimationFrameId = null;
let activeSignPointerId = null; // 複数ポインター同時操作を防ぐため、操作中のpointerIdを1つだけ保持する
let pendingReleaseDebug = null; // DEBUG_SIGN_RELEASE_VELOCITY用に、release計算〜spin完了までの計測値を橋渡しする一時オブジェクト

// 低速反時計回り操作の方向反転バグ対策: releaseVelocityが小さすぎて信頼できない場合でも、
// 直前に観測された実際のドラッグ方向を優先して回転方向を決めるための状態。
let lastSignDragDirection = 0; // pointerdownで0にリセットし、有効な角度移動があるたびに±1で更新する
const MIN_DIRECTION_DELTA_DEG = 0.2; // これ未満の1サンプルあたりの角度差はノイズとみなし方向を更新しない
const MIN_DIRECTIONAL_VELOCITY = SIGN_PHYSICS.minFlickVelocity; // これ以上の角速度なら、その符号をそのまま信頼する
const DEFAULT_TAP_SPIN_DIRECTION = 1; // 方向情報が一切無い完全なタップの既定回転方向（時計回り）

// 回転方向の決定優先順位: 1) 十分な大きさのある実測リリース速度の符号
// 2) 低速でも直前に観測された実際のドラッグ方向 3) 完全なタップの既定方向。
// releaseVelocityがNaN/Infinity・小さすぎる場合でも、ユーザーの入力方向を勝手に反転させないためのもの。
function resolveSpinDirection(releaseVelocity) {
  if (Number.isFinite(releaseVelocity) && Math.abs(releaseVelocity) >= MIN_DIRECTIONAL_VELOCITY) {
    return Math.sign(releaseVelocity);
  }
  if (lastSignDragDirection !== 0) {
    return lastSignDragDirection;
  }
  return DEFAULT_TAP_SPIN_DIRECTION;
}
let spinStartRotationForDebug = 0; // DEBUG_SIGN_RELEASE_VELOCITY用に、回転量の実測に使う開始角度

function logSignReleaseVelocityDebug() {
  if (!DEBUG_SIGN_RELEASE_VELOCITY || !pendingReleaseDebug) return;
  console.log("[sign-release-velocity]", pendingReleaseDebug);
  pendingReleaseDebug = null;
}

function logSignDebug(label, data) {
  if (!DEBUG_SIGN_PHYSICS) return;
  console.log(`[sign-physics] ${label}`, data);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

// candidateSectors の中から、frontierResult の優先方向に近いほど選ばれやすい重み付き抽選を行う。
// タップ時は8方位すべてを、フリック時は自然停止角度周辺の3方位のみを候補として渡す想定。
function pickWeightedSector(candidateSectors, frontierResult) {
  const hasFrontier = frontierResult && frontierResult.hasFrontier;
  const weights = candidateSectors.map((s) => {
    if (!hasFrontier) return 1; // 未踏方向の偏りが無ければ均等ランダム
    const raw = Math.abs(s - frontierResult.sector);
    const dist = Math.min(raw, 8 - raw);
    return DIRECTION_WEIGHT_BY_DISTANCE[dist];
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < candidateSectors.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidateSectors[i];
  }
  return candidateSectors[0];
}

// 自然停止方角(現在の回転角に最も近い8方位)を中心に、左右隣の方角を候補化して
// 未踏方向へ重み付けした抽選を行う。ただし、現在の回転方向(dirSign)を維持したまま
// 到達しようとすると"ほぼ1周分の遠回り"になってしまう側の隣接候補は、不自然に大きな
// 回転を招くため候補から除外する（未踏方向ロジックによる急な逆回転も同時に防ぐ）。
const MAX_NATURAL_SNAP_DELTA_DEG = 225;

function pickFlickLandingSector(currentRotation, dirSign, frontierResult) {
  const mod = ((currentRotation % 360) + 360) % 360;
  const natural = Math.round(mod / 45) % 8;
  const rawCandidates = [natural, (natural + 7) % 8, (natural + 1) % 8];
  const reachable = rawCandidates.filter((s) => {
    const delta = computeFinalRotation(currentRotation, s * 45, dirSign, 0) - currentRotation;
    return Math.abs(delta) <= MAX_NATURAL_SNAP_DELTA_DEG;
  });
  const candidates = reachable.length > 0 ? reachable : [natural];
  return { natural, candidates, targetSector: pickWeightedSector(candidates, frontierResult) };
}

function getFrontierForSign() {
  const refLatLon = lastKnownLatLon || (origin ? { lat: origin.lat0, lon: origin.lon0 } : null);
  if (!refLatLon) return { hasFrontier: false };
  if (compassResult && compassResult.hasFrontier) return compassResult;
  return computeFrontierDirection(refLatLon.lat, refLatLon.lon);
}

function getSignBoardCenter() {
  const rect = el("sign-board").getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function angleFromCenter(clientX, clientY, center) {
  return (Math.atan2(clientY - center.y, clientX - center.x) * 180) / Math.PI;
}

// 0度と360度をまたぐ角度差を -180〜180度の範囲へ正規化する。
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

// current(現在の回転角、度・無制限) から、spinSignの向きを保ったまま targetBearingDeg(0-359)へ
// extraRotations回分の360度を追加してから到達する最終回転角を返す。
function computeFinalRotation(current, targetBearingDeg, spinSign, extraRotations) {
  const currentMod = ((current % 360) + 360) % 360;
  const deltaCW = (targetBearingDeg - currentMod + 360) % 360;
  const delta = spinSign >= 0 ? deltaCW : deltaCW === 0 ? 0 : deltaCW - 360;
  return current + spinSign * extraRotations * 360 + delta;
}

function trimPointerHistory(history, now) {
  // 直近 historyWindowMs 分だけを残す。ただし速度算出には最低2点必要なので2点は必ず残す。
  while (history.length > 2 && now - history[0].timestamp > SIGN_PHYSICS.historyWindowMs) {
    history.shift();
  }
}

// ブラウザが複数の細かなポインター移動を1つのpointermove/pointerupへ統合している場合に備え、
// getCoalescedEvents()が使えるならその生サンプル列を、使えない・空なら元イベント1件を返す。
function getPointerSamples(event) {
  if (typeof event.getCoalescedEvents === "function") {
    try {
      const coalesced = event.getCoalescedEvents();
      if (coalesced && coalesced.length > 0) return coalesced;
    } catch (err) {
      // 未対応・失敗時は元イベントへフォールバックする
    }
  }
  return [event];
}

// pointerdown/pointermove/pointerup(とそのcoalesced event)共通のサンプル記録処理。
// 角度差の正規化・累積回転・履歴追加をまとめて行う。異常サンプルや完全な重複は無視する。
function recordSignPointerSample(sample) {
  if (!signDragState) return;
  if (sample.pointerId != null && sample.pointerId !== activeSignPointerId) return; // 他ポインターのサンプルは無視
  const angle = angleFromCenter(sample.clientX, sample.clientY, signDragState.center);
  if (!Number.isFinite(angle)) return; // 座標異常なサンプルは除外

  const history = signDragState.history;
  const last = history[history.length - 1];
  const rawTimestamp =
    typeof sample.timeStamp === "number" && Number.isFinite(sample.timeStamp) ? sample.timeStamp : performance.now();

  // 直前と完全に同じ時刻・同じ角度の重複サンプルは追加しない
  if (last && rawTimestamp === last.timestamp && angle === signDragState.lastAngle) return;

  const delta = normalizeAngleDelta(angle - signDragState.lastAngle);
  signDragState.lastAngle = angle;
  signDragState.cumulativeDelta += delta;
  currentSignRotation = signDragState.startRotation + signDragState.cumulativeDelta;

  // ノイズ以上の角度移動があれば、そのときの向きを「直前に観測された実際のドラッグ方向」として保持する。
  // releaseVelocityが低速・不正で信頼できない場合の方向決定フォールバックに使う。
  //
  // 1サンプルごとの差分ではなく、最後に方向を確定したチェックポイント(directionRefDelta)からの
  // 累積差分で判定する。getCoalescedEvents()は1回の指の動きを非常に細かい(1サンプルあたり
  // 0.1度未満の)複数サンプルへ分割することがあり、1サンプルごとの差分だけを見ていると
  // 「実際は明確に方向のある動きなのに、どのサンプル単体も閾値未満」となって方向を
  // 見失ってしまうため（低速・微小な反時計回り操作が既定方向へフォールバックしてしまうバグの原因）。
  const deltaSinceDirectionCheckpoint = signDragState.cumulativeDelta - signDragState.directionRefDelta;
  if (Math.abs(deltaSinceDirectionCheckpoint) >= MIN_DIRECTION_DELTA_DEG) {
    lastSignDragDirection = Math.sign(deltaSinceDirectionCheckpoint);
    signDragState.directionRefDelta = signDragState.cumulativeDelta;
  }

  // timeStampが前サンプル以前(逆行・重複)の場合は、順序を保つため直前+微小値へ補正する
  const timestamp = last && rawTimestamp <= last.timestamp ? last.timestamp + 0.01 : rawTimestamp;
  history.push({ angle: currentSignRotation, timestamp });
}

function onSignPointerDown(e) {
  if (activeSignPointerId !== null && activeSignPointerId !== e.pointerId) return; // 複数ポインター同時操作は無視
  cancelSignAnimation(); // 回転中でもその場で掴み直せるようにする
  pendingReleaseDebug = null; // 直前の回転が未完了のまま掴み直された場合、古い計測値を持ち越さない
  lastSignDragDirection = 0; // 新しい操作の開始時にリセットする（今回の操作で観測した方向だけを使うため）
  activeSignPointerId = e.pointerId;
  const board = el("sign-board");
  try {
    board.setPointerCapture(e.pointerId);
  } catch (err) {
    // ポインターキャプチャ非対応でも操作自体は継続する
  }
  const center = getSignBoardCenter();
  const angle = angleFromCenter(e.clientX, e.clientY, center);
  const now = performance.now();
  signDragState = {
    center,
    lastAngle: angle,
    cumulativeDelta: 0,
    directionRefDelta: 0, // 最後にlastSignDragDirectionを確定した時点のcumulativeDelta（チェックポイント）
    startRotation: currentSignRotation,
    downTime: now,
    browserEventCount: 0,
    coalescedSampleCount: 0,
    history: [{ angle: currentSignRotation, timestamp: now }],
  };
  board.classList.add("dragging");
}

function onSignPointerMove(e) {
  if (!signDragState || e.pointerId !== activeSignPointerId) return;
  signDragState.browserEventCount++;
  const samples = getPointerSamples(e);
  signDragState.coalescedSampleCount += samples.length;
  samples.forEach(recordSignPointerSample);
  applySignRotation(currentSignRotation); // ドラッグ中は慣性・イージング無しで指へ直接追従させる
  const now = performance.now();
  trimPointerHistory(signDragState.history, now);
}

// 履歴のうち直近(historyWindowMs以内)の最古〜最新サンプルから角速度を算出する単純な2点法。
// 新しい加重平均計算(calculateReleaseAngularVelocity)が使えない場合の安全なフォールバックとして使う。
function computeReleaseVelocity(history) {
  if (!history || history.length < 2) return 0;
  const first = history[0];
  const last = history[history.length - 1];
  const dt = last.timestamp - first.timestamp;
  if (dt < SIGN_PHYSICS.minVelocitySampleDt) return 0;
  const v = (last.angle - first.angle) / dt;
  return Number.isFinite(v) ? v : 0;
}

function hasEnoughVelocityData(samples) {
  if (!samples || samples.length < SIGN_RELEASE_VELOCITY.minimumSampleCount) return false;
  const span = samples[samples.length - 1].timestamp - samples[0].timestamp;
  return span >= SIGN_RELEASE_VELOCITY.minimumWindowMs;
}

// 直近preferredWindowMs以内のサンプルを優先し、不足していればfallbackWindowMsまで範囲を広げる。
// それでも不十分なら履歴全体を返し、呼び出し側の2点法フォールバックに委ねる。
function selectVelocityWindow(history) {
  if (!history || history.length < 2) return history || [];
  const latestTime = history[history.length - 1].timestamp;
  const preferred = history.filter((s) => latestTime - s.timestamp <= SIGN_RELEASE_VELOCITY.preferredWindowMs);
  if (hasEnoughVelocityData(preferred)) return preferred;
  const fallback = history.filter((s) => latestTime - s.timestamp <= SIGN_RELEASE_VELOCITY.fallbackWindowMs);
  if (hasEnoughVelocityData(fallback)) return fallback;
  return history;
}

// ウィンドウ内での時間的な位置(0=最古側,1=最新側)に応じて、直近の区間ほど重くなる重みを返す。
function calculateRecencyWeight(segmentEndTime, windowStartTime, windowDuration) {
  if (windowDuration <= 0) return 1;
  const recency = clamp01((segmentEndTime - windowStartTime) / windowDuration);
  return 1 + Math.pow(recency, SIGN_RELEASE_VELOCITY.recencyWeightPower) * SIGN_RELEASE_VELOCITY.recencyWeightMax;
}

// pointerup直前の角速度を、直近ウィンドウ内の区間ごとの加重平均(+任意でピーク速度とのブレンド)で算出する。
// 「最初はゆっくり、最後だけ鋭くはじく」操作でも、最後の区間の速度が全体平均で薄まらないことを狙う。
function calculateReleaseAngularVelocity(fullHistory) {
  const debug = {};
  const window = selectVelocityWindow(fullHistory);

  if (!hasEnoughVelocityData(window)) {
    const fallbackSource = window && window.length >= 2 ? window : fullHistory;
    const fallbackVelocity = computeReleaseVelocity(fallbackSource);
    debug.fallbackUsed = true;
    debug.selectedSampleCount = fallbackSource ? fallbackSource.length : 0;
    return { velocity: fallbackVelocity, debug };
  }

  const windowStartTime = window[0].timestamp;
  const windowDuration = window[window.length - 1].timestamp - windowStartTime;

  let weightedSum = 0;
  let totalWeight = 0;
  let peak = 0;

  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1];
    const cur = window[i];
    const dt = cur.timestamp - prev.timestamp;
    if (dt <= 0) continue; // 時間差ゼロ以下の区間は除外
    const deltaAngle = normalizeAngleDelta(cur.angle - prev.angle);
    const velocity = deltaAngle / dt;
    if (!Number.isFinite(velocity) || Math.abs(velocity) > SIGN_RELEASE_VELOCITY.maxSegmentVelocity) continue; // 異常値除外
    const weight = calculateRecencyWeight(cur.timestamp, windowStartTime, windowDuration);
    weightedSum += velocity * weight;
    totalWeight += weight;
    if (Math.abs(velocity) > Math.abs(peak)) peak = velocity;
  }

  if (totalWeight === 0) {
    const fallbackVelocity = computeReleaseVelocity(fullHistory);
    debug.fallbackUsed = true;
    return { velocity: fallbackVelocity, debug };
  }

  const weightedAverage = weightedSum / totalWeight;
  const blended = SIGN_RELEASE_VELOCITY.usePeakBlend
    ? weightedAverage * RELEASE_VELOCITY_BLEND.weightedAverageRatio + peak * RELEASE_VELOCITY_BLEND.recentPeakRatio
    : weightedAverage;

  debug.selectedWindowMs = windowDuration;
  debug.selectedSampleCount = window.length;
  debug.rawWeightedVelocity = weightedAverage;
  debug.recentPeakVelocity = peak;
  debug.blendedVelocity = blended;

  return { velocity: blended, debug };
}

function onSignPointerUp(e) {
  if (!signDragState || e.pointerId !== activeSignPointerId) return;
  const board = el("sign-board");
  try {
    board.releasePointerCapture(e.pointerId);
  } catch (err) {
    // 無視して継続
  }
  board.classList.remove("dragging");

  // 最後のpointermoveからpointerupまでの動きが履歴から欠落しないよう、
  // pointerup自身(とそのcoalesced event)も速度算出の前に履歴へ追加する。
  // recordSignPointerSample()はactiveSignPointerIdとの一致でサンプルを検証するため、
  // これをnullにするのはサンプル記録が終わった後でなければならない。
  const upSamples = getPointerSamples(e);
  signDragState.coalescedSampleCount += upSamples.length;
  upSamples.forEach(recordSignPointerSample);
  applySignRotation(currentSignRotation);
  activeSignPointerId = null;

  const now = performance.now();
  const cumulativeDelta = signDragState.cumulativeDelta;
  const movedAngle = Math.abs(cumulativeDelta);
  const duration = now - signDragState.downTime;
  const browserSampleCount = signDragState.browserEventCount;
  const coalescedSampleCount = signDragState.coalescedSampleCount;

  const releaseResult = calculateReleaseAngularVelocity(signDragState.history);
  const velocityDegPerMs = releaseResult.velocity;
  signDragState = null;

  // タップ判定: 動かした角度が小さいことを必須条件にする。
  // 角度が小さい場合に限り、短時間で離したか、離す直前の角速度が極めて小さければタップ扱い。
  // （movedAngleを見ずに velocity だけでタップ判定すると、"ゆっくり大きく動かして離す"
  //   ような弱フリックまでタップの固定回転量に丸められてしまうため、角度条件をANDにしている。）
  // 「タップ扱い」は回転の強さ・時間を控えめにするための分類であり、方向の決定は
  // resolveSpinDirection()に一本化する（低速でも実際のドラッグ方向があればそれを尊重する）。
  const isTap =
    movedAngle < SIGN_PHYSICS.tapMaxAngleDeg &&
    (duration < SIGN_PHYSICS.tapMaxDurationMs || Math.abs(velocityDegPerMs) < SIGN_PHYSICS.minFlickVelocity);
  const resolvedSpinDirection = resolveSpinDirection(velocityDegPerMs);

  logSignDebug("release", {
    movedAngle,
    duration,
    velocityDegPerMs,
    lastSignDragDirection,
    resolvedSpinDirection,
    classification: isTap ? "tap" : "flick",
  });

  if (DEBUG_SIGN_RELEASE_VELOCITY) {
    pendingReleaseDebug = {
      ...releaseResult.debug,
      browserSampleCount,
      coalescedSampleCount,
      totalGestureDurationMs: duration,
      totalDragAngle: movedAngle,
      releaseVelocity: velocityDegPerMs,
      lastSignDragDirection,
      resolvedSpinDirection,
    };
  }

  if (isTap) {
    startTapSpin(velocityDegPerMs);
    return;
  }
  startFlickSpin(Math.abs(velocityDegPerMs), resolvedSpinDirection);
}

function onSignPointerCancel(e) {
  if (!signDragState || e.pointerId !== activeSignPointerId) return;
  const board = el("sign-board");
  try {
    board.releasePointerCapture(e.pointerId);
  } catch (err) {
    // 無視して継続
  }
  board.classList.remove("dragging");
  activeSignPointerId = null;
  signDragState = null;
  // ジェスチャーが中断された場合は回転を開始せず、安全に元の状態(現在の角度)へ戻すだけにする。
}

/* ---- 回転そのもの: タップ／ボタン／フリックの3系統 → 最終的に runInertiaSpin か
   簡易トゥイーンのどちらかへ合流し、finishSpin() で8方位への確定を行う。 ---- */

// spinSign(+1/-1) × extraRotations(0/1) の4通りの中から、合計回転量が
// tapSpinRotationRangeDeg(既定90〜270度)に収まる組み合わせを優先して選ぶ。
// どれも範囲に収まらない場合（目標方位がすでに現在角度のごく近くにある等）は、
// レンジの中心に最も近いものへフォールバックする。
// spinSignは呼び出し元(resolveSpinDirection)で確定済みの回転方向。ここでは、その方向を
// 維持したまま extraRotations(0または1) だけを選び、合計回転量がレンジに近づくよう調整する。
// 方向自体をここで選び直すことはしない（それが低速反時計回りの反転バグの原因だったため）。
function pickTapRotationPlan(startRotation, targetBearingDeg, spinSign) {
  const [minDeg, maxDeg] = SIGN_PHYSICS.tapSpinRotationRangeDeg;
  const mid = (minDeg + maxDeg) / 2;
  const minVisibleDeg = 30; // これ未満の回転量は「動いた」と感じにくいため、可能な限り避ける
  const candidates = [0, 1].map((extra) => {
    const finalRotation = computeFinalRotation(startRotation, targetBearingDeg, spinSign, extra);
    const totalRotation = Math.abs(finalRotation - startRotation);
    return { spinSign, finalRotation, totalRotation };
  });
  const pickClosestToMid = (pool) => {
    pool.sort((a, b) => Math.abs(a.totalRotation - mid) - Math.abs(b.totalRotation - mid));
    return pool[0];
  };
  const inRange = candidates.filter((c) => c.totalRotation >= minDeg && c.totalRotation <= maxDeg);
  if (inRange.length > 0) return pickClosestToMid(inRange);
  // 目標方位が現在角度のごく近くにある等でレンジに収まらない場合は、
  // 見た目上ほぼ動かなくなる候補を避けつつ、レンジ中心に近いものへフォールバックする。
  const visible = candidates.filter((c) => c.totalRotation >= minVisibleDeg);
  return pickClosestToMid(visible.length > 0 ? visible : candidates);
}

// releaseVelocity: pointerup直前に実測した角速度(NaN/未指定でも可)。
// 方向はresolveSpinDirection()に一本化し、「回転量が良い方の向きを選ぶ」ことはしない
// （そうすると低速だが明確なドラッグ方向を持つ操作の向きが無視されてしまうため）。
function startTapSpin(releaseVelocity) {
  cancelSignAnimation();
  signSpinning = true;
  el("sign-board").classList.add("spinning");

  const frontier = getFrontierForSign();
  const targetSector = pickWeightedSector([0, 1, 2, 3, 4, 5, 6, 7], frontier);
  const startRotation = currentSignRotation;
  const targetBearingDeg = targetSector * 45;
  const reducedMotion = prefersReducedMotion();
  const spinSign = resolveSpinDirection(releaseVelocity);
  const plan = pickTapRotationPlan(startRotation, targetBearingDeg, spinSign);

  if (pendingReleaseDebug) {
    pendingReleaseDebug.mappedSpinMagnitude = plan.totalRotation;
    pendingReleaseDebug.finalSpinVelocity = spinSign;
    pendingReleaseDebug.snapDirection = spinSign;
    pendingReleaseDebug.targetAngle = plan.finalRotation;
    logSignReleaseVelocityDebug();
  }

  if (reducedMotion) {
    currentSignRotation = plan.finalRotation;
    applySignRotation(currentSignRotation); // reduced-motion用CSSトランジションで短く遷移する
    logSignDebug("tap-spin", { targetSector, spinSign, plan, reducedMotion });
    setTimeout(() => finishSpin(targetSector), 220);
    return;
  }

  const duration = randRange(SIGN_PHYSICS.tapSpinDurationRangeMs[0], SIGN_PHYSICS.tapSpinDurationRangeMs[1]);
  logSignDebug("tap-spin", { targetSector, spinSign, plan, duration });
  tweenRotation(startRotation, plan.finalRotation, duration, () => finishSpin(targetSector));
}

function startButtonSpin() {
  if (signDragState) return; // ドラッグ中はボタン操作を無視する
  cancelSignAnimation();
  const spinSign = Math.random() < 0.5 ? -1 : 1;
  logSignDebug("button-spin", { spinSign, inputVelocity: SIGN_PHYSICS.buttonSpinVelocity });
  startFlickSpin(SIGN_PHYSICS.buttonSpinVelocity, spinSign); // 中程度のフリック相当の疑似入力を使う
}

// inputVelocityDegPerMs: pointerup直前に実測した角速度の絶対値(deg/ms)。
// これを正規化・カーブ変換した上で、慣性回転の初速(deg/ms)へマッピングする。
function startFlickSpin(inputVelocityDegPerMs, spinSign) {
  // 安全装置: NaN/Infinityな角速度・符号を物理計算に持ち込まず、安全なタップ扱いにフォールバックする。
  // releaseVelocityを渡しても resolveSpinDirection() が不正値を検知して
  // lastSignDragDirection/既定方向へ自動的に落ちるため、方向は失われない。
  if (!Number.isFinite(inputVelocityDegPerMs) || !Number.isFinite(spinSign)) {
    startTapSpin(inputVelocityDegPerMs);
    return;
  }
  cancelSignAnimation();
  const clamped = Math.min(
    SIGN_PHYSICS.maxInputVelocity,
    Math.max(SIGN_PHYSICS.minFlickVelocity, Math.abs(inputVelocityDegPerMs))
  );
  const normalized = clamp01(
    (clamped - SIGN_PHYSICS.minFlickVelocity) / (SIGN_PHYSICS.maxInputVelocity - SIGN_PHYSICS.minFlickVelocity)
  );
  const curved = Math.pow(normalized, SIGN_PHYSICS.velocityCurvePower);
  const spinVelocity =
    SIGN_PHYSICS.minSpinVelocity + curved * (SIGN_PHYSICS.maxSpinVelocity - SIGN_PHYSICS.minSpinVelocity);
  // 摩擦も入力強度で補間する（弱い入力ほど速く止まり、強い入力ほど長く/多く回る）。
  const friction =
    SIGN_PHYSICS.frictionPerFrameAt60fpsMin +
    curved * (SIGN_PHYSICS.frictionPerFrameAt60fpsMax - SIGN_PHYSICS.frictionPerFrameAt60fpsMin);

  logSignDebug("flick-spin-start", { inputVelocityDegPerMs, spinSign, normalized, curved, spinVelocity, friction });
  if (pendingReleaseDebug) {
    pendingReleaseDebug.rawReleaseVelocity = inputVelocityDegPerMs;
    pendingReleaseDebug.clampedVelocity = clamped;
    pendingReleaseDebug.mappedSpinVelocity = spinVelocity;
    pendingReleaseDebug.mappedSpinMagnitude = spinVelocity;
    pendingReleaseDebug.finalSpinVelocity = spinVelocity * spinSign;
  }
  runInertiaSpin(spinVelocity * spinSign, friction);
}

// pointerup時の実測角速度を初速として、摩擦による減速→8方位への吸着まで駆動する物理ループ。
// フレームレートに依存しないよう、フレームごとの経過時間(dt)を使って移動量・摩擦を適用する。
function runInertiaSpin(signedVelocityDegPerMs, frictionPerFrameAt60fps) {
  signSpinning = true;
  el("sign-board").classList.add("spinning");
  spinStartRotationForDebug = currentSignRotation;

  if (prefersReducedMotion()) {
    finishReducedMotionSpin(signedVelocityDegPerMs);
    return;
  }

  let velocity = signedVelocityDegPerMs; // deg/ms（符号付き）
  let lastFrameTime = performance.now();
  const inertiaStartTime = lastFrameTime;

  function step(now) {
    // 安全装置: 万一ここまでにNaN/Infinityが混入していたら、暴走させず現在角度から即座に吸着させる。
    if (!Number.isFinite(velocity) || !Number.isFinite(currentSignRotation)) {
      currentSignRotation = Number.isFinite(currentSignRotation) ? currentSignRotation : 0;
      const dirSign = signedVelocityDegPerMs >= 0 ? 1 : -1;
      const frontier = getFrontierForSign();
      const { targetSector } = pickFlickLandingSector(currentSignRotation, dirSign, frontier);
      const finalRotation = computeFinalRotation(currentSignRotation, targetSector * 45, dirSign, 0);
      beginOvershootSettle(currentSignRotation, finalRotation, targetSector, dirSign);
      return;
    }

    const dt = Math.min(now - lastFrameTime, 48); // フレーム落ち時の1ステップ上限（暴走防止）
    lastFrameTime = now;

    currentSignRotation += velocity * dt;
    applySignRotation(currentSignRotation);

    // 摩擦はフレーム数ではなく経過時間に対応させる（60fps基準の係数を時間比でべき乗する）。
    const frictionFactor = Math.pow(frictionPerFrameAt60fps, dt / (1000 / 60));
    velocity *= frictionFactor;

    const speed = Math.abs(velocity);
    const overMaxDuration = now - inertiaStartTime >= SIGN_PHYSICS.maxSpinDurationMs;

    if (speed <= SIGN_PHYSICS.snapVelocityThreshold || overMaxDuration) {
      const dirSign = velocity !== 0 ? Math.sign(velocity) : signedVelocityDegPerMs >= 0 ? 1 : -1;
      const frontier = getFrontierForSign();
      const { natural, targetSector } = pickFlickLandingSector(currentSignRotation, dirSign, frontier);
      const finalRotation = computeFinalRotation(currentSignRotation, targetSector * 45, dirSign, 0);
      logSignDebug("inertia-end", {
        elapsedMs: now - inertiaStartTime,
        natural,
        targetSector,
        finalRotation,
        overMaxDuration,
      });
      if (pendingReleaseDebug) {
        pendingReleaseDebug.spinDurationMs = now - inertiaStartTime;
        pendingReleaseDebug.estimatedRotations = Math.abs(currentSignRotation - spinStartRotationForDebug) / 360;
        pendingReleaseDebug.snapDirection = dirSign;
        pendingReleaseDebug.targetAngle = finalRotation;
        logSignReleaseVelocityDebug();
      }
      beginOvershootSettle(currentSignRotation, finalRotation, targetSector, dirSign);
      return;
    }

    signAnimationFrameId = requestAnimationFrame(step);
  }

  signAnimationFrameId = requestAnimationFrame(step);
}

function finishReducedMotionSpin(signedVelocityDegPerMs) {
  const dirSign = signedVelocityDegPerMs >= 0 ? 1 : -1;
  const frontier = getFrontierForSign();
  const { targetSector } = pickFlickLandingSector(currentSignRotation, dirSign, frontier);
  // 強さに応じて最大1回転程度まで、短いトランジションで確定する（オーバーシュート・高速回転は行わない）。
  const strength = clamp01(Math.abs(signedVelocityDegPerMs) / SIGN_PHYSICS.maxSpinVelocity);
  const rotations = strength > 0.5 ? 1 : 0;
  const finalRotation = computeFinalRotation(currentSignRotation, targetSector * 45, dirSign, rotations);
  currentSignRotation = finalRotation;
  applySignRotation(currentSignRotation); // reduced-motion用CSSトランジションで短く遷移する
  logSignDebug("reduced-motion-spin", { dirSign, targetSector, finalRotation, strength });
  if (pendingReleaseDebug) {
    pendingReleaseDebug.spinDurationMs = 240;
    pendingReleaseDebug.estimatedRotations = Math.abs(currentSignRotation - spinStartRotationForDebug) / 360;
    logSignReleaseVelocityDebug();
  }
  setTimeout(() => finishSpin(targetSector), 240);
}

// 慣性減速の終着点(finalRotation)へ向けて、現在の回転方向を保ったまま
// 数度だけオーバーシュート→小さく戻る、の2段階で自然に吸着させる。
function beginOvershootSettle(fromRotation, finalRotation, targetSector, dirSign) {
  const overshootRotation = finalRotation + dirSign * SIGN_PHYSICS.overshootDeg;
  tweenRotation(fromRotation, overshootRotation, SIGN_PHYSICS.overshootDurationMs, () => {
    tweenRotation(overshootRotation, finalRotation, SIGN_PHYSICS.settleBackDurationMs, () => {
      finishSpin(targetSector);
    });
  });
}

// from→toへ、指定ミリ秒かけてease-outで単純に遷移する汎用トゥイーン。
// フレームレートに依存しないよう経過時間ベースで進捗を計算する。
function tweenRotation(from, to, durationMs, onDone) {
  const startTime = performance.now();
  function step(now) {
    const t = Math.min(1, (now - startTime) / Math.max(1, durationMs));
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    currentSignRotation = from + (to - from) * eased;
    applySignRotation(currentSignRotation);
    if (t < 1) {
      signAnimationFrameId = requestAnimationFrame(step);
      return;
    }
    signAnimationFrameId = null;
    onDone();
  }
  signAnimationFrameId = requestAnimationFrame(step);
}

function finishSpin(targetSector) {
  signSpinning = false;
  el("sign-board").classList.remove("spinning");
  logSignDebug("settled", { targetSector, finalRotation: currentSignRotation });
  onSignSettled(targetSector);
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
  // パネルを開くたびに標識の操作状態を安全にリセットする
  cancelSignAnimation();
  activeSignPointerId = null;
  signDragState = null;
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
  signBoard.addEventListener("pointercancel", onSignPointerCancel);
  el("btn-spin-sign").addEventListener("click", startButtonSpin);
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
