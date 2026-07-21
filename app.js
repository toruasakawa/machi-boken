/* ==========================================================
   マチ冒険 MVP — 未踏セル開放 × 勾配クエスト
   ========================================================== */

// LeafletのSVGレンダラーは既定でビューポート寸法の10%(padding:0.1)しか描画範囲を
// 広げないため、それを超えた場所にあるL.rectangle等は座標が空になり完全に不可視化する
// (色・不透明度・z-index・paneに関係なく起こる)。霧は最大 CELL_SIZE_M *
// (CELL_FOG_CONFIG.ringCells + 1) メートル先まで生成するため、それを
// 安全に包含できる値にしておく（実測: 375px/320px幅いずれもpadding:4で全セル正常描画）。
const MAP_SVG_RENDER_PADDING = 4;

// 地図を見て方向を選ぶ補助モード（標識フリックの代わりに、地図タップで方角を選ぶ）。
// 経路案内・目的地保存機能ではなく、あくまで8方位を決めるための一時的な操作。
const MAP_DIRECTION_INITIAL_ZOOM = 16; // 通常のズーム(17)よりわずかに広く表示する固定値
const MAP_DIRECTION_SIGN_SPIN_MS = 600; // 確定後、標識が選択方向へ回る所要時間（0.4〜0.8秒の範囲）

const CELL_SIZE_M = 200; // 1セルの一辺（メートル）
const QUEST_RING_CELLS = 4; // 現在地から何セル分の範囲でクエスト候補を探すか（≒800m）
const MAX_QUEST_CANDIDATES = 10; // 標高APIに投げる候補数の上限
const ELEVATION_ENDPOINT = "https://api.open-elevation.com/api/v1/lookup";
const ELEVATION_TIMEOUT_MS = 8000; // 標高APIが固まった場合に諦めるまでの時間

// 勾配クエスト: 現在の標高データだけでは特定地点が周辺で最上位の急さだと断定できないため、
// 候補地点として扱う表記・演出へ変更する（候補選定アルゴリズム自体は変更しない）。
const SLOPE_QUEST_LABEL = "勾配スポット";
const SLOPE_QUEST_ARRIVAL_MESSAGE = "勾配スポットに到達！";
const SLOPE_QUEST_CONFETTI = { intensity: "small", durationMs: 1200 }; // 時間達成と同程度〜やや弱め、累計節目より弱い
// 到達演出のタイミング目安（すべて概算。歩行中でも読める長さを優先する）
const SLOPE_QUEST_TIMING = {
  checkStateDelayMs: 1000, // ポップ演出が落ち着いてからチェック済み状態へ切り替えるまで
  reducedCheckStateDelayMs: 60, // reduced-motionでは即時に近い切り替えにする
  holdCompletedMs: 1500, // チェック済み状態のまま見せておく時間
  removeFadeMs: 400, // フェードアウトして地図から取り除くまでの所要時間
};
const SLOPE_QUEST_NOTIFICATION_TIMING = {
  fadeInMs: 150,
  holdMs: 1800,
  fadeOutMs: 200,
  reducedFadeInMs: 80,
  reducedFadeOutMs: 80,
};
const DEBUG_SLOPE_QUEST = false; // trueにすると到達判定・演出の計測値をコンソールへ出力する（本番はfalse）

const ACCURACY_OPEN_M = 60; // これより誤差が大きい測位ではセル開放/クエスト達成の判定に使わない
const ACCURACY_WARN_M = 100; // これより誤差が大きい場合はユーザーに知らせる
const ACCURACY_WARN_INTERVAL_MS = 15000; // 精度低下トーストを連発させないための間隔

// フロンティア・コンパス: 8方位ラベル（北を0として45度刻み・時計回り）
const COMPASS_LABELS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
const FRONTIER_COLLAPSE_DISTANCE_M = 30; // 累積移動がこれを超えたら展開→縮小に切り替える
const FRONTIER_RECOMPUTE_DISTANCE_M = 100; // 前回の再計算地点からこれだけ動いたら方角を再計算する
const FRONTIER_SWITCH_MARGIN = 2; // 新しい方位の未踏セル数が現在の提案より何件以上多ければ切り替えるか（僅差ならちらつき防止のため維持）

// 未踏セルの霧（体験仮説の検証用・軽量実装）。実機調整はこのオブジェクトだけで完結させる。
const CELL_FOG_CONFIG = {
  enabled: true, // 全体のON/OFFスイッチ（検証を止めたい場合はfalseにするだけでよい）
  ringCells: QUEST_RING_CELLS, // 霧を描く範囲。クエスト探索と同じ半径(±4セル≒800m四方)を流用し、無制限生成を防ぐ
  fillColor: "#eef2f3", // 霧の塗り色（白系。地図が灰色の格子に見えすぎない濃さへ調整可）
  fillOpacity: 0.8,
  strokeColor: "#ffffff",
  strokeOpacity: 0.25,
  strokeWeight: 1,
  // 霧が晴れる演出（styles.cssの@keyframes fog-reveal/explored-cell-appearと数値を合わせること）
  revealDurationMs: 850, // 霧が完全に消えるまでの所要時間（フラッシュ含む全体の長さ）
  flashDurationMs: 140, // 霧が消え始める直前、一瞬だけ明るくなる時間
  exploredFadeInDelayMs: 250, // 霧が消え始めてから、探索済み色のフェードインを始めるまでの遅延
  exploredFadeInDurationMs: 600, // 探索済み色のフェードインにかける時間（delay+duration=revealDurationMs）
  maxRenderedFogCells: 100, // 霧レイヤーの上限。モバイルでのDOM/SVG要素数を保護する
};
const DEBUG_CELL_FOG = false; // trueにすると霧の計測値をコンソールへ出力する（本番はfalse）

// 冒険プリセット: 達成条件は選択した時間。セル数は成果としてのみ扱う。
const ADVENTURE_PRESETS = {
  short: {
    minutes: 5,
    label: "ちょい冒険",
    targetDurationMs: 5 * 60 * 1000,
  },
  normal: {
    minutes: 15,
    label: "いつもの冒険",
    targetDurationMs: 15 * 60 * 1000,
  },
  long: {
    minutes: 30,
    label: "じっくり冒険",
    targetDurationMs: 30 * 60 * 1000,
  },
};
const ADVENTURE_PRESET_ORDER = ["short", "normal", "long"];
const ADVENTURE_TIMER_INTERVAL_MS = 1000;
const TIME_GOAL_PRESENTATION_DELAY_MS = 180;

// 距離は終了画面用。小さなGPS揺れと明らかなジャンプを成果へ混ぜない。
const DISTANCE_MIN_STEP_M = 3;
const DISTANCE_MAX_STEP_M = 500;
const DISTANCE_MAX_SPEED_MPS = 4.5;
const DISTANCE_MAX_ACCURACY_M = 35;

// 冒険中に歩いたGPS軌跡を、終了画面で抽象的な線として見せるための記録設定。
// 精度・速度・ジャンプ判定は距離計測(DISTANCE_MAX_ACCURACY_M等)と同じ基準を参照し、
// 「距離表示とルート形状で採用するGPS点の基準が大きく異ならない」ようにする。
// ここに無いのは「新しい点として保存するか」という記録間隔だけの追加条件。
const ROUTE_RECORDING_CONFIG = {
  maxAccuracyM: DISTANCE_MAX_ACCURACY_M,
  minDistanceM: 10, // 前回保存点からこれ以上動いたら新しい点を保存する
  maxIntervalMs: 15000, // これ以上経過し、かつ少し位置が変化していれば保存する
  minIntervalDistanceM: 3, // ↑の「少し変化」の下限（GPSノイズだけでの保存を避ける）
  maxSegmentDistanceM: DISTANCE_MAX_STEP_M, // これを超える区間はGPSジャンプとして線に含めない
  maxSpeedMps: DISTANCE_MAX_SPEED_MPS,
  maxPoints: 1000, // 配列の上限。超えたら2点に1点へ間引く（先頭の開始点は残す）
};
// 実機レビュー時だけURLへ ?debugRouteShape=1 を付け、件数・描画先・フォールバック有無を確認する。
const DEBUG_ROUTE_SHAPE = Boolean(
  typeof window !== "undefined" &&
    window.location &&
    new URLSearchParams(window.location.search).get("debugRouteShape") === "1",
);

// ルート形状の描画設定。地図タイルは使わず、SVGの相対座標だけで「形」を残す。
const ROUTE_SHAPE_VIEWBOX = { width: 320, height: 170, padding: 24 };
const ROUTE_SHAPE_MIN_SPAN_M = 0.5; // これ未満の幅・高さは「ほぼ同一点」とみなしゼロ除算を避ける
const ROUTE_SHAPE_DRAW_DURATION_MS = 1000; // 線が描かれるアニメーションの所要時間

// 時間達成は区切りとして軽く見せ、未踏セル発見より派手にしない。
const TIME_GOAL_COMPLETION_EFFECT = { intensity: "small", durationMs: 1000 };
const CONFETTI_PIECE_COUNTS = {
  small: 12,
  medium: 18,
  mediumLarge: 24,
};
// 霧晴れの後に2段階で見せる。reduced-motionでもhold時間は短縮しない。
const DISCOVERY_MESSAGE_TIMING = {
  firstFadeInMs: 150,
  firstHoldMs: 1500,
  firstFadeOutMs: 180,
  secondFadeInMs: 150,
  secondHoldMs: 1250,
  secondFadeOutMs: 180,
  reducedFadeInMs: 80,
  reducedFadeOutMs: 80,
};
const MILESTONE_MESSAGE_TIMING = {
  fadeInMs: 150,
  holdMs: 2200,
  fadeOutMs: 180,
};
const TIME_GOAL_MESSAGE_TIMING = {
  fadeInMs: 150,
  holdMs: 2200,
  fadeOutMs: 180,
  reducedFadeInMs: 80,
  reducedFadeOutMs: 80,
};
const ADVENTURE_GOAL_MESSAGE = "今日の冒険を達成しました！";
const DEBUG_TIME_GOAL = false;

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
const ADVENTURE_END_MESSAGES = {
  noDiscovery: "今日の寄り道も、正解でした。",
  withDiscovery: "またこの街が、少し広くなりました。",
};

// 夜間セーフティ: 端末のローカル時刻ベース（18:00〜翌5:59を夜間とする）
// 夜間でも冒険時間は昼間と同じ3コースを維持し、時間制限はしない。
// 「知らない道」を積極的に推奨せず、安全な道を選ぶよう文言だけで促す方針。
const NIGHT_START_HOUR = 18;
const NIGHT_END_HOUR = 6; // この時刻未満は夜間

// 夜間の方向確定後の補足文（プリセットごと）。「普段なら選ばない道」を推奨せず、
// 安全な道を選ぶことを促す。昼間の文言(onSignSettled内)はここでは変更しない。
const NIGHT_DIRECTION_SUB_TEXT = {
  short: "この方角を意識しながら、明るく歩き慣れた道を少し歩いてみよう。",
  normal: "この方角を意識しつつ、慣れた道や人通りのある道を歩いてみよう。",
  long: "無理をせず、明るく安全な道を選んで歩いてみよう。",
};

const DEBUG_NIGHT_MODE = false; // trueにすると夜間モードの判定値をコンソールへ出力する（本番はfalse）

function logNightModeDebug(event) {
  if (!DEBUG_NIGHT_MODE) return;
  console.log("[night-mode]", event, {
    localTime: new Date().toTimeString().slice(0, 8),
    isNightTime: isNightTime(),
    selectedPresetMinutes: adventureState.preset
      ? ADVENTURE_PRESETS[adventureState.preset].minutes
      : null,
    availablePresetMinutes: ADVENTURE_PRESET_ORDER.map(
      (key) => ADVENTURE_PRESETS[key].minutes,
    ),
    nightSafetyAcknowledged: adventureState.nightSafetyAcknowledged,
    nightCopyVariant: adventureState.preset,
    adventureStartAllowed: !isNightTime() || adventureState.nightSafetyAcknowledged,
  });
}

// 方角の重み付け: index=フロンティア方位からの円環距離(0=最優先,4=反対)
const DIRECTION_WEIGHT_BY_DISTANCE = [10, 5, 2, 1, 1];

// 道路標識（方向決定UI）の物理定数。実機調整はこのオブジェクトだけで完結するようにする。
// 単位は角度=度(deg)、角速度=度/ミリ秒(deg/ms)で統一している。
const SIGN_PHYSICS = {
  historyWindowMs: 150, // pointerup直前、角速度算出に使う履歴の時間窓
  minVelocitySampleDt: 8, // 角速度算出に使う最古〜最新サンプルの最小間隔(ms未満は採用しない)
  tapMaxAngleDeg: 6, // これ未満の正味移動量ならタップ候補
  tapMaxDurationMs: 250, // これ未満の操作時間ならタップ候補
  minFlickVelocity: 0.06, // これ未満の角速度(deg/ms)は事実上タップ扱い（フリックの下限でもある）
  maxInputVelocity: 1.6, // 入力角速度(deg/ms)の実測上限の目安。これ以上はclampする
  minSpinVelocity: 3.9, // 慣性回転の初速下限(deg/ms)（タップ以外の最弱フリック）
  maxSpinVelocity: 5.7, // 慣性回転の初速上限(deg/ms)（最強フリック）
  velocityCurvePower: 0.7, // 入力強度→初速・摩擦のカーブ指数(1未満で弱入力側の差を強調)
  // 摩擦は初速に応じて可変にする（強い入力ほど摩擦を弱めて長く/多く回るようにし、
  // 回転数と停止時間の両方が入力強度に連動して伸びるようにする）。
  frictionPerFrameAt60fpsMin: 0.878, // 最弱フリック時の摩擦係数（小さいほど速く減速）
  frictionPerFrameAt60fpsMax: 0.949, // 最強フリック時の摩擦係数（大きいほどゆっくり減速＝長く回る）
  snapVelocityThreshold: 0.02, // 角速度がこれ未満まで減衰したら吸着フェーズへ移行(deg/ms)
  overshootDeg: 4, // 吸着直前の小さなオーバーシュート量(度)
  overshootDurationMs: 200, // オーバーシュート角度までの所要時間
  settleBackDurationMs: 150, // オーバーシュートから最終角度へ戻る所要時間
  maxSpinDurationMs: 2500, // 慣性回転フェーズの最大許容時間（安全装置。これを超えたら強制的に吸着へ）
  tapSpinRotationRangeDeg: [90, 270], // タップ時の回転量の目安レンジ(度。0.25〜0.75回転相当)
  tapSpinDurationRangeMs: [500, 900], // タップ時の停止フェーズ所要時間の目安レンジ
  buttonSpinVelocity: 0.55, // 「標識を回す」ボタン押下時に使う疑似入力速度(deg/ms、中程度のフリック相当)
};

const DEBUG_SIGN_PHYSICS = false; // trueにすると操作の計測値・分類・初速などをコンソールへ出力する

// pointerup直前のリリース角速度をどう算出するかの設定。
// 「最後だけ強くはじく」操作を、履歴全体の平均で薄めずに正しく拾うことが目的。
const SIGN_RELEASE_VELOCITY = {
  preferredWindowMs: 80, // まずこの時間内(直近)のサンプルだけで速度を計算する
  fallbackWindowMs: 150, // 直近サンプルが不十分なら、ここまで範囲を広げる
  minimumWindowMs: 24, // これ未満の時間差では信頼できる速度が出せない
  minimumSampleCount: 3, // 採用ウィンドウ内に必要な最小サンプル数
  recencyWeightPower: 2, // 直近ほど重みを強める指数（大きいほど最新区間を強調）
  recencyWeightMax: 3, // 直近区間に上乗せされる重みの最大値（基本重み1 + これ）
  maxSegmentVelocity: 50, // 1区間の角速度がこれを超えたら明らかな外れ値として除外する(deg/ms)
  usePeakBlend: true, // 加重平均だけでなく、直近ピーク速度も少量ブレンドするか
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
  // "am_quest"は廃止。勾配スポット候補は1冒険につき1地点に固定するためadventureState.slopeQuest
  // (セッション限定・localStorage未保存)へ移行した。既存ブラウザに残る値は今後読み書きしない。
  log: "am_log",
  milestones: "am_milestones",
  privacyAck: "am_share_privacy_ack",
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
let visited = store.get(STORAGE_KEYS.visited, {}); // { "ix_iy": {ts,lat,lon} }
let log = store.get(STORAGE_KEYS.log, []); // [{ts, type, label}]

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

// 未踏セルの霧の状態（すべてセッション限定。localStorageへは保存しない）
let fogLayer = null; // 霧レイヤー（L.layerGroup）
let fogRenderer = null; // 霧pane専用のSVGレンダラー（padding拡張のため個別に生成する。理由はinitMap参照）
let currentLocationRenderer = null; // 現在地pane専用のSVGレンダラー（冒険で地図中心から離れても消えないように同様に拡張）
let mapDirectionRenderer = null; // 地図で方向を選ぶ補助モード用のpane専用SVGレンダラー
const fogLayersByCellId = new Map(); // セルID -> 霧のLeafletレイヤー（重複防止・差分更新用）
let lastFogCenterCell = null; // 直近に霧を再計算した中心セル（無駄な再計算を防ぐ）

function initMap(lat, lon) {
  map = L.map("map", { zoomControl: false, attributionControl: false }).setView(
    [lat, lon],
    17,
  );
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  L.control.attribution({ prefix: false, position: "bottomleft" }).addTo(map);

  // 霧は専用paneに分離し、タイル→霧→訪問済み→現在地の順に重ねる。
  // pane自体にpointer-events:noneを設定することで、地図のドラッグ・ズーム・タップを一切妨げない。
  const fogPane = map.createPane("fogPane");
  fogPane.style.zIndex = 350; // tilePane(200) < fogPane < overlayPane(400, 訪問済みセル・現在地)
  fogPane.style.pointerEvents = "none";
  const currentLocationPane = map.createPane("currentLocationPane");
  currentLocationPane.style.zIndex = 450; // 訪問済み色より上、クエスト旗(markerPane=600)より下に現在地を保つ
  currentLocationPane.style.pointerEvents = "none";
  // 地図で方向を選ぶ補助モード用の方向線・タップ地点。クエスト旗(markerPane=600)より上に置き、
  // 重なっても見失わないようにする。pointer-events:noneで地図のパン・ズーム・タップは妨げない。
  const mapDirectionPane = map.createPane("mapDirectionPane");
  mapDirectionPane.style.zIndex = 620;
  mapDirectionPane.style.pointerEvents = "none";

  // 独自paneはLeafletの既定レンダラー(map.options.renderer)を継承せず、パン名ごとに
  // 新しいSVGレンダラーをpadding:0.1(既定)で自動生成してしまう。霧は最大
  // CELL_SIZE_M*(ringCells + 1) メートル先まで生成するため、既定paddingの
  // 描画範囲を超えたセルは座標が空になり完全に不可視化する（色・z-indexとは無関係の不具合）。
  // 現在地マーカーも、冒険で歩いて地図中心から離れると同じ理由で消えうるため合わせて対象にする。
  // 方向線も、選択後に地図をパンして離れると同じ理由で消えうるため合わせて対象にする。
  // pane専用のレンダラーを明示的に作り、各レイヤー生成時にrendererオプションで渡すことで防ぐ。
  fogRenderer = L.svg({ pane: "fogPane", padding: MAP_SVG_RENDER_PADDING }).addTo(map);
  currentLocationRenderer = L.svg({
    pane: "currentLocationPane",
    padding: MAP_SVG_RENDER_PADDING,
  }).addTo(map);
  mapDirectionRenderer = L.svg({
    pane: "mapDirectionPane",
    padding: MAP_SVG_RENDER_PADDING,
  }).addTo(map);

  fogLayer = L.layerGroup().addTo(map);
  cellsLayer = L.layerGroup().addTo(map);
  questLayer = L.layerGroup().addTo(map);

  meMarker = L.circleMarker([lat, lon], {
    pane: "currentLocationPane",
    renderer: currentLocationRenderer,
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

  // 勾配スポット候補はadventureState.slopeQuest(セッション限定)へ移行したため、
  // ページ読み込み直後にlocalStorageから復元することはしない（冒険自体もリロードでは復元しない）。
}

const EXPLORED_CELL_FILL_OPACITY = 0.28; // 探索済みセルの最終的な塗り不透明度
const EXPLORED_CELL_STROKE_OPACITY = 1; // 探索済みセルの最終的な輪郭不透明度

function drawVisitedCell(ix, iy, opts) {
  // 新規発見時(isNewlyDiscovered)だけ0から開始し、CSSのフェードインで最終値まで持っていく。
  // reduced-motionでも「短いフェード」は残す方針のため、ここではモーション設定による分岐をしない
  // （実際の長さはstyles.cssの@media (prefers-reduced-motion: reduce)側で短縮する）。
  const isNewlyDiscovered = !!(opts && opts.animate);
  const rect = L.rectangle(cellBoundsLatLon(ix, iy), {
    className: "cell-rect map-cell-explored",
    color: "#f59e0b",
    weight: 1,
    fillColor: "#f59e0b",
    fillOpacity: isNewlyDiscovered ? 0 : EXPLORED_CELL_FILL_OPACITY,
    opacity: isNewlyDiscovered ? 0 : EXPLORED_CELL_STROKE_OPACITY,
  }).addTo(cellsLayer);

  if (isNewlyDiscovered) {
    const element = rect.getElement();
    if (element) {
      element.style.setProperty("--explored-fill-opacity", EXPLORED_CELL_FILL_OPACITY);
      element.style.setProperty("--explored-stroke-opacity", EXPLORED_CELL_STROKE_OPACITY);
      element.classList.add("is-revealing");
    }
  }
  return rect;
}

// 勾配スポットの候補マーカー本体。丸型ピンは現在地マーカー(円形・amber塗り)と
// 見分けがつきにくかったため、旗竿+旗布のフラッグ型（丸を使わない形）へ変更した。
let questMarker = null; // 現在表示中の勾配スポットマーカー（Leafletインスタンス）
let slopeQuestMarkerTimers = []; // 到達演出（チェック済み化・フェードアウト）用のタイマーID
// 到達演出(チェック済み化→フェードアウト)が終わるまでtrueにする。単なる同一tick内の
// 多重実行ガードだけでなく、演出中にdrawQuestMarker()が再度呼ばれた場合に
// 完了直後のマーカーを早期に消してしまうのを防ぐためにも使う。
let slopeQuestCompletionInProgress = false;
let pendingQuestMarkerRedraw = false; // 演出中に再描画要求が来た場合、演出後にadventureState.slopeQuestから改めて描画する

function clearSlopeQuestCompletionTimers() {
  slopeQuestMarkerTimers.forEach((id) => clearTimeout(id));
  slopeQuestMarkerTimers = [];
  // タイマーごと止める＝演出サイクルは完了しないため、ガードを持ち越さないようここでも解除する
  slopeQuestCompletionInProgress = false;
  pendingQuestMarkerRedraw = false;
}

// 到達演出サイクル全体（チェック済み化→保持→フェードアウト削除）が終わったときに呼ぶ。
// 演出中に保留されていた再描画要求があれば、ここで初めて反映する。
function finishSlopeQuestCompletionCycle() {
  slopeQuestCompletionInProgress = false;
  if (pendingQuestMarkerRedraw) {
    pendingQuestMarkerRedraw = false;
    drawQuestMarker();
  }
}

// 旗竿(pole)+旗布(cloth)のフラッグ型マーカー。円は使わない。
// clothの中身は未到達時は空、到達済みは"✓"のみ（絵文字の見た目に依存せずCSSで形自体を作る）。
function buildSlopeQuestIconHtml(isCompleted) {
  const clothContent = isCompleted ? "✓" : "";
  return `<span class="slope-quest-marker__ring"></span><span class="slope-quest-marker__pole"></span><span class="slope-quest-marker__cloth">${clothContent}</span>`;
}

// 1冒険につき固定された候補(adventureState.slopeQuest)だけを描画する。引数は取らず、
// 候補生成結果を直接受け取って描画することはしない（フラッグを固定するための唯一の入口）。
function drawQuestMarker() {
  const q = adventureState.slopeQuest;
  if (q.status !== "ready" && q.status !== "completed") return;
  if (slopeQuestCompletionInProgress) {
    // 完了演出（チェック済み表示→フェードアウト）の途中で描き直さない。
    // 演出が終わった時点(finishSlopeQuestCompletionCycle)で改めて描画する。
    pendingQuestMarkerRedraw = true;
    logSlopeQuestDebug("marker-redraw-deferred", { questCellId: q.cellId });
    return;
  }
  questLayer.clearLayers();
  clearSlopeQuestCompletionTimers();
  const icon = L.divIcon({
    className: "slope-quest-marker",
    html: buildSlopeQuestIconHtml(q.status === "completed"),
    iconSize: [48, 48], // タップ領域(48x48)は44x44px以上の目安を満たす
    iconAnchor: [24, 46], // 旗竿の根元（地面に立っている位置）を地図座標に合わせる
  });
  questMarker = L.marker([q.lat, q.lng], { icon }).addTo(questLayer);
  questMarker.on("click", (e) => {
    // 地図で方向を選ぶ補助モード中は、旗をタップしても目的地確定しない。
    // 通常の地図タップと同じ扱いにし、その位置への方角だけを示す。
    if (mapDirectionModeActive) {
      handleMapDirectionTap(e);
      return;
    }
    openQuestPanel();
  });
  const element = questMarker.getElement();
  if (element) {
    element.setAttribute("aria-label", `${SLOPE_QUEST_LABEL}候補`);
  }
}

// 冒険終了時、地図からフラッグを外す（次の冒険まで表示し続けない）。ただし到達演出の
// 途中(slopeQuestCompletionInProgress)であれば、演出は最後まで自然に終わらせてから
// 既存のremoveSlopeQuestMarker()に任せる（達成演出そのものは変更しない）。
function retireSlopeQuestMarkerForEndOfAdventure() {
  if (slopeQuestCompletionInProgress) return;
  if (questLayer) questLayer.clearLayers();
  questMarker = null;
}

/* ==========================================================
   未踏セルの霧（現在地周辺(CELL_FOG_CONFIG.ringCells圏内)の未踏セルにだけ薄い半透明レイヤーを表示する）
   どの未踏セルへ入っても同じ価値で霧が晴れる。特定セルを目的地のように扱う処理は持たない。
   状態はすべてセッション限定。visited(既存データ)から毎回導出するため、localStorageは変更しない。
   ========================================================== */
function logCellFogDebug(event, extra) {
  if (!DEBUG_CELL_FOG) return;
  console.log("[cell-fog]", event, {
    visibleFogCellCount: fogLayersByCellId.size,
    ...extra,
  });
}

// 現在地を中心に、visitedに基づいて霧セルの表示を差分更新する。
// 中心セル(ix,iy)が変わらない限り再計算しないため、GPS更新のたびに全レイヤーを作り直すことはない。
function updateFogCells(lat, lon) {
  if (!CELL_FOG_CONFIG.enabled || !map || !fogLayer) return;

  const { ix: cix, iy: ciy } = cellIndex(lat, lon);
  if (
    lastFogCenterCell &&
    lastFogCenterCell.ix === cix &&
    lastFogCenterCell.iy === ciy
  )
    return;
  lastFogCenterCell = { ix: cix, iy: ciy };

  const ring = CELL_FOG_CONFIG.ringCells;
  const desired = new Set();
  for (let dx = -ring; dx <= ring; dx++) {
    for (let dy = -ring; dy <= ring; dy++) {
      const key = cellKey(cix + dx, ciy + dy);
      if (visited[key]) continue; // 訪問済みセルには霧を出さない
      desired.add(key);
    }
  }

  // 範囲外になった霧を削除する（移動でレイヤー数が際限なく増え続けないようにする）
  fogLayersByCellId.forEach((rect, key) => {
    if (desired.has(key)) return;
    fogLayer.removeLayer(rect);
    fogLayersByCellId.delete(key);
  });

  // 不足分だけ追加する（既に霧があるセルは再生成しない＝重複防止）
  desired.forEach((key) => {
    if (fogLayersByCellId.has(key)) return;
    if (fogLayersByCellId.size >= CELL_FOG_CONFIG.maxRenderedFogCells) return; // 性能保護の上限
    const [ix, iy] = key.split("_").map(Number);
    const rect = L.rectangle(cellBoundsLatLon(ix, iy), {
      pane: "fogPane",
      renderer: fogRenderer, // pane既定のレンダラー(padding不足)ではなく、拡張paddingのレンダラーを明示使用
      interactive: false,
      className: "map-cell-fog",
      color: CELL_FOG_CONFIG.strokeColor,
      opacity: CELL_FOG_CONFIG.strokeOpacity,
      weight: CELL_FOG_CONFIG.strokeWeight,
      fillColor: CELL_FOG_CONFIG.fillColor,
      fillOpacity: CELL_FOG_CONFIG.fillOpacity,
    }).addTo(fogLayer);
    fogLayersByCellId.set(key, rect);
  });

  logCellFogDebug("fog-updated", {});
}

// 未踏セル(ix,iy)の霧を「晴れる」演出付きで解除する。どの未踏セルへ入っても同じ処理・同じ価値。
function revealFogCell(ix, iy) {
  const key = cellKey(ix, iy);
  const rect = fogLayersByCellId.get(key);
  if (!rect) return; // 圏外や既に霧が無いセルは何もしない
  fogLayersByCellId.delete(key); // 同じセルへの多重解除を防ぐため、先にMapから外す

  const finish = () => {
    if (fogLayer) fogLayer.removeLayer(rect);
    logCellFogDebug("fog-reveal-completed", {
      currentCellId: key,
      revealCompleted: true,
    });
  };

  const element = rect.getElement();
  if (element && !prefersReducedMotion()) {
    element.classList.add("is-revealing");
    setTimeout(finish, CELL_FOG_CONFIG.revealDurationMs + 60);
  } else {
    finish(); // reduced-motion、または要素未取得時は即時解除する
  }
}

/* ---------- HUD / パネル操作 ---------- */
const el = (id) => document.getElementById(id);

function updateHud(currentLat, currentLon) {
  el("stat-cells").textContent = Object.keys(visited).length;
  const q = adventureState.slopeQuest;
  if (q.status === "ready") {
    const d = Math.round(haversineMeters(currentLat, currentLon, q.lat, q.lng));
    el("stat-quest").textContent = `${d}m`;
  } else {
    el("stat-quest").textContent = "--";
  }
}

function showToast(msg, variant) {
  if (isDiscoveryNotificationActive()) {
    // 発見中の通常通知は1件だけ保留し、文章同士の重なりと無制限キューを防ぐ。
    showToast._pending = { msg, variant };
    return;
  }
  const t = el("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  t.classList.toggle("toast-milestone", variant === "milestone");
  clearTimeout(showToast._timer);
  const duration = variant === "milestone" ? 3400 : 2600;
  showToast._timer = setTimeout(() => t.classList.add("hidden"), duration);
}

function prefersReducedMotion() {
  return !!(
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function openQuestPanel() {
  el("quest-panel").classList.remove("hidden");
  const q = adventureState.slopeQuest;
  if (q.status === "ready" || q.status === "completed") {
    el("quest-desc").textContent = "地図上の勾配スポットへ行ってみよう。";
    el("quest-gradient").textContent =
      q.score != null ? `勾配目安 ${q.score}%` : "勾配 不明";
  } else {
    el("quest-desc").textContent =
      "周辺を探索すると勾配スポット候補が見つかります。";
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
      c.elevationM = elev; // デバッグログ用。選定式（gradientPct）自体はここでは変更しない
      const gradient = Math.abs(elev - curElev) / Math.max(c.dist, 1);
      c.gradientPct = Math.round(gradient * 100 * 10) / 10;
    });

    shortlist.sort((a, b) => b.gradientPct - a.gradientPct);
    const picked = shortlist[0];
    // 一時デバッグ用: 平坦な地点が選ばれていないかを確認するための計測値。
    // minimumRequiredGradePercentは現状常にnull＝最小勾配条件はまだ存在しない（未実装であることをそのまま示す）。
    if (DEBUG_SLOPE_QUEST) {
      console.log("[slope-quest-candidate]", {
        candidateLat: picked.lat,
        candidateLng: picked.lon,
        startElevationM: curElev,
        endElevationM: picked.elevationM,
        elevationDifferenceM: Math.abs(picked.elevationM - curElev),
        horizontalDistanceM: picked.dist,
        estimatedGradePercent: picked.gradientPct,
        candidateScore: picked.gradientPct,
        minimumRequiredGradePercent: null,
        selectionReason: "highest-estimated-grade-in-shortlist",
        usedFallback: false,
        renderedMarkerLat: picked.lat,
        renderedMarkerLng: picked.lon,
      });
    }
    return picked;
  } catch (e) {
    // 標高APIが失敗した場合は距離最短の候補をフォールバックにする
    const fallback = { ...shortlist[0], gradientPct: null };
    if (DEBUG_SLOPE_QUEST) {
      console.log("[slope-quest-candidate]", {
        candidateLat: fallback.lat,
        candidateLng: fallback.lon,
        startElevationM: null,
        endElevationM: null,
        elevationDifferenceM: null,
        horizontalDistanceM: fallback.dist,
        estimatedGradePercent: null,
        candidateScore: null,
        minimumRequiredGradePercent: null,
        selectionReason: "elevation-api-failed-nearest-distance-fallback",
        usedFallback: true,
        renderedMarkerLat: fallback.lat,
        renderedMarkerLng: fallback.lon,
      });
    }
    return fallback;
  }
}

// requestIdの一意な発行。crypto.randomUUIDが無い環境（古いWebView等）でも動くようフォールバックする。
function createSlopeQuestRequestId() {
  return (
    (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
    `${Date.now()}-${Math.random()}`
  );
}

// 1冒険につき候補は1回だけ選定し、冒険終了まで固定する入口。GPS更新のたびに呼ばれるが、
// 実際に検索が始まるのは「冒険中・slopeQuestが未選定(idle)・信頼できる現在地がある」の
// 3条件を満たす最初の1回だけ（他の呼び出しは即座に無視される）。
async function ensureQuest() {
  if (adventureState.status !== "active") {
    logSlopeQuestLockDebug({ candidateGenerationAttempted: false, candidateIgnoredReason: "adventure-inactive" });
    return;
  }
  const currentStatus = adventureState.slopeQuest.status;
  if (currentStatus !== "idle") {
    const reasonByStatus = {
      pending: "already-pending",
      ready: "already-ready",
      completed: "already-completed",
      unavailable: "unavailable-for-this-session",
    };
    logSlopeQuestLockDebug({
      candidateGenerationAttempted: false,
      candidateIgnoredReason: reasonByStatus[currentStatus] || currentStatus,
    });
    return;
  }
  if (!lastReliablePosition) {
    logSlopeQuestLockDebug({ candidateGenerationAttempted: false, candidateIgnoredReason: "no-reliable-position" });
    return;
  }

  const requestId = createSlopeQuestRequestId();
  const sessionIdAtRequest = adventureState.sessionId;
  adventureState.slopeQuest.status = "pending";
  adventureState.slopeQuest.requestId = requestId;
  logSlopeQuestLockDebug({ candidateGenerationAttempted: true, candidateIgnoredReason: null });

  let picked = null;
  try {
    picked = await generateQuest(lastReliablePosition.lat, lastReliablePosition.lon);
  } catch (e) {
    picked = null;
  }

  // 応答が返るまでの間に、新しい冒険が始まった／冒険が終わった／別の検索が上書きされた
  // 可能性をすべて確認してから採用する（遅れて返った古い応答が最新候補を上書きしないように）。
  if (adventureState.sessionId !== sessionIdAtRequest) {
    logSlopeQuestLockDebug({ candidateGenerationAttempted: true, candidateIgnoredReason: "previous-session" });
    return;
  }
  if (adventureState.status !== "active") {
    logSlopeQuestLockDebug({ candidateGenerationAttempted: true, candidateIgnoredReason: "adventure-inactive" });
    return;
  }
  if (adventureState.slopeQuest.requestId !== requestId) {
    logSlopeQuestLockDebug({ candidateGenerationAttempted: true, candidateIgnoredReason: "stale-request" });
    return;
  }
  if (adventureState.slopeQuest.status !== "pending") {
    logSlopeQuestLockDebug({
      candidateGenerationAttempted: true,
      candidateIgnoredReason: `already-${adventureState.slopeQuest.status}`,
    });
    return;
  }

  if (!picked) {
    adventureState.slopeQuest.status = "unavailable";
    logSlopeQuestLockDebug({
      candidateGenerationAttempted: true,
      candidateIgnoredReason: null,
      markerRedrawReason: "no-candidate-available",
    });
    return;
  }

  adventureState.slopeQuest.status = "ready";
  adventureState.slopeQuest.lat = picked.lat;
  adventureState.slopeQuest.lng = picked.lon;
  adventureState.slopeQuest.cellId = cellKey(picked.ix, picked.iy);
  adventureState.slopeQuest.score = picked.gradientPct;

  logSlopeQuestLockDebug({
    candidateGenerationAttempted: true,
    candidateIgnoredReason: null,
    markerRedrawReason: "candidate-adopted",
    previousMarkerLat: null,
    previousMarkerLng: null,
    newMarkerLat: picked.lat,
    newMarkerLng: picked.lon,
  });
  drawQuestMarker();
  updateHud(lastReliablePosition.lat, lastReliablePosition.lon);
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
        ((Math.atan2(cXY.x - curXY.x, cXY.y - curXY.y) * 180) / Math.PI + 360) %
        360;
      const sector = Math.round(bearingDeg / 45) % 8;
      const dist = haversineMeters(curLat, curLon, c.lat, c.lon);

      counts[sector]++;
      totalUnvisited++;
      if (dist < nearestDistBySector[sector])
        nearestDistBySector[sector] = dist;
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
let compassResult = null; // 直近のcomputeFrontierDirection()の結果
let lastCompassCheckLatLon = null; // 最後に方位を再計算した地点（100m移動判定の基準）
let compassMoveBaseLatLon = null; // 累積移動距離を測るための直近地点（30m縮小判定の基準）
let compassMoveAccumM = 0; // 縮小判定用の累積移動距離
let lastKnownLatLon = null; // タップで再展開した際に即座に再計算するための直近位置

function recomputeCompass(lat, lon) {
  const prevSector =
    compassResult && compassResult.hasFrontier ? compassResult.sector : null;
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
    if (hasFrontier)
      arrow.style.transform = `rotate(${compassResult.bearingDeg}deg)`;
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
    compassMoveAccumM += haversineMeters(
      compassMoveBaseLatLon.lat,
      compassMoveBaseLatLon.lon,
      lat,
      lon,
    );
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
    haversineMeters(
      lastCompassCheckLatLon.lat,
      lastCompassCheckLatLon.lon,
      lat,
      lon,
    ) >= FRONTIER_RECOMPUTE_DISTANCE_M;

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
  direction: null, // {sector, label, bearingDeg}
  directionSelectionMode: null, // "flick" | "map"（デバッグ・将来の分析用。終了画面には表示しない。localStorageへも保存しない）
  startedAt: null,
  endedAt: null,
  elapsedAdventureMs: 0,
  initialTargetDurationMs: 0,
  startLatLon: null, // 冒険開始地点（帰り道用）
  startCellId: null,
  hasLeftStartCell: false,
  goalReached: false,
  timeGoalNotificationPending: false,
  timeGoalConfettiSuppressed: false,
  sessionVisitedCellIds: new Set(),
  sessionVisitedCells: [], // セッション内で歩いたセル座標（終了画面には表示しない）
  sessionDiscoveredCellIds: new Set(),
  sessionDiscoveredCells: [], // セッション内で発見したセル座標（発見数とは分離して保持する）
  distanceMeters: 0,
  lastDistancePoint: null,
  routePoints: [], // 冒険中に記録したGPS軌跡 [{lat,lon,timestamp,accuracy,cumulativeDistanceM}]（セッション限定）
  lastRoutePoint: null, // 直前に「保存」した有効なルート点（記録間隔の判定に使う。lastDistancePointとは別管理）
  slopeQuestCompleted: false, // 勾配スポットへ到達済みか（セッション限定。終了画面のバッジ表示に使う）
  slopeQuestNotificationPending: false, // 発見通知・節目の後に回すための表示待ちフラグ
  // 1回の冒険につき候補は1地点だけ選び、冒険終了まで固定する。現在地更新・霧更新・地図パンでは
  // 動かさない。status: idle(未選定) -> pending(検索中) -> ready(固定表示) -> completed(到達済み)
  // または unavailable(候補なし)。ready/completed/unavailableでは同じ冒険中に再検索しない。
  slopeQuest: {
    status: "idle",
    lat: null,
    lng: null,
    cellId: null,
    score: null,
    requestId: null,
  },
  completionData: null,
  currentCellId: null,
  discoveryFeedbackUntil: 0,
  nightSafetyAcknowledged: false, // 夜間注意を確認済みか（セッション限定。同じ冒険開始フロー内での再表示を防ぐ）
  sessionId: 0, // 遅延した達成演出が次の冒険へ持ち越されないよう、新しいコース選択ごとに更新する
};
let adventureFeedbackTimerIds = [];
let adventureTimerId = null;

function clearAdventureFeedbackTimers() {
  adventureFeedbackTimerIds.forEach((timerId) => clearTimeout(timerId));
  adventureFeedbackTimerIds = [];
}

function scheduleAdventureFeedbackAction(sessionId, delayMs, action) {
  const timerId = setTimeout(() => {
    adventureFeedbackTimerIds = adventureFeedbackTimerIds.filter(
      (id) => id !== timerId,
    );
    if (adventureState.sessionId !== sessionId) return;
    action();
  }, delayMs);
  adventureFeedbackTimerIds.push(timerId);
}

function stopAdventureTimer() {
  if (adventureTimerId != null) {
    clearInterval(adventureTimerId);
    adventureTimerId = null;
  }
}

function startAdventureTimer() {
  stopAdventureTimer();
  updateAdventureTime();
  adventureTimerId = setInterval(
    updateAdventureTime,
    ADVENTURE_TIMER_INTERVAL_MS,
  );
}

function getElapsedAdventureMs(startedAt, now) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return 0;
  return Math.max(0, now - startedAt);
}

function formatAdventureMinutes(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 60 * 1000) return "1分未満";
  return `${Math.floor(durationMs / (60 * 1000))}分`;
}

function formatAdventureDistance(distanceMeters) {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) return "0m";
  if (distanceMeters < 1000) return `${Math.round(distanceMeters)}m`;
  return `${(distanceMeters / 1000).toFixed(1)}km`;
}

function logTimeGoalDebug(event, overrides) {
  if (!DEBUG_TIME_GOAL) return;
  const preset = adventureState.preset
    ? ADVENTURE_PRESETS[adventureState.preset]
    : null;
  console.log("[time-goal]", event, {
    selectedPresetMinutes: preset ? preset.minutes : null,
    startedAt: adventureState.startedAt,
    elapsedAdventureMs: adventureState.elapsedAdventureMs,
    initialTargetDurationMs: adventureState.initialTargetDurationMs,
    goalReached: adventureState.goalReached,
    timeGoalNotificationPending: adventureState.timeGoalNotificationPending,
    sessionVisitedCellCount: adventureState.sessionVisitedCellIds.size,
    sessionDiscoveredCellCount: adventureState.sessionDiscoveredCellIds.size,
    currentCellId: adventureState.currentCellId,
    timeGoalTriggered: false,
    discoveryTriggered: false,
    ...(overrides || {}),
  });
}

function updateAdventureTime(now) {
  if (adventureState.status !== "active" || !adventureState.startedAt) return;
  const currentTime = Number.isFinite(now) ? now : Date.now();
  adventureState.elapsedAdventureMs = getElapsedAdventureMs(
    adventureState.startedAt,
    currentTime,
  );
  renderAdventureHud();
  triggerAdventureTimeGoal();
}

function renderAdventureUI() {
  const s = adventureState.status;
  el("duration-panel").classList.toggle("hidden", s !== "choosingDuration");
  el("direction-panel").classList.toggle("hidden", s !== "choosingDirection");
  el("adventure-hud").classList.toggle("hidden", s !== "active");
  el("completion-sheet").classList.toggle("hidden", s !== "completed");
  el("btn-begin-adventure").classList.toggle(
    "hidden",
    !(s === "idle" || s === "completed"),
  );
  if (s !== "active") hideTimeGoalNotification();
}

function setAdventureStatus(status) {
  adventureState.status = status;
  renderAdventureUI();
}

function resetAdventureStateKeepHistory() {
  stopAdventureTimer();
  clearAdventureFeedbackTimers();
  clearDiscoveryNotification({ flushPendingToast: false });
  adventureState.preset = null;
  adventureState.direction = null;
  adventureState.directionSelectionMode = null;
  adventureState.startedAt = null;
  adventureState.endedAt = null;
  adventureState.elapsedAdventureMs = 0;
  adventureState.initialTargetDurationMs = 0;
  adventureState.startLatLon = null;
  adventureState.startCellId = null;
  adventureState.hasLeftStartCell = false;
  adventureState.goalReached = false;
  adventureState.timeGoalNotificationPending = false;
  adventureState.timeGoalConfettiSuppressed = false;
  adventureState.sessionVisitedCellIds = new Set();
  adventureState.sessionVisitedCells = [];
  adventureState.sessionDiscoveredCellIds = new Set();
  adventureState.sessionDiscoveredCells = [];
  adventureState.distanceMeters = 0;
  adventureState.lastDistancePoint = null;
  adventureState.routePoints = [];
  adventureState.lastRoutePoint = null;
  adventureState.slopeQuestCompleted = false;
  adventureState.slopeQuestNotificationPending = false;
  // slopeQuest状態自体のリセットは新しい冒険開始時(selectAdventurePreset)だけで行う。
  // ここでは、冒険終了後すぐに到達演出タイマー(チェック済み化・フェードアウト)を止め、
  // 次のセッションへ持ち越さないようにする（実際のフラッグ削除はendAdventure側で行う）。
  clearSlopeQuestCompletionTimers();
  adventureState.completionData = null;
  adventureState.discoveryFeedbackUntil = 0;
  adventureState.nightSafetyAcknowledged = false; // 新しい冒険開始時は夜間注意を再表示してよいためリセットする
}

function renderAdventureHud() {
  if (!adventureState.direction) return;
  el("adventure-hud-direction").textContent =
    `${adventureState.direction.label}へ冒険中`;
  el("adventure-hud-progress").textContent =
    getAdventureProgressText({
      elapsedAdventureMs: adventureState.elapsedAdventureMs,
      sessionVisitedCellCount: adventureState.sessionVisitedCellIds.size,
      goalReached: adventureState.goalReached,
    });
}

function getAdventureProgressText({
  elapsedAdventureMs,
  sessionVisitedCellCount,
  goalReached,
}) {
  const statusLabel = goalReached ? "冒険達成" : "冒険中";
  return `${statusLabel} ${formatAdventureMinutes(elapsedAdventureMs)} ・ 歩いた場所 ${sessionVisitedCellCount}`;
}

// アプリ起動後、初回の位置取得・地図準備が完了した直後に一度だけ呼ばれる（handlePosition内）。
// それ以外に、地図画面の「冒険開始」ボタンからも同じ入口を使う。
function beginAdventureFlow() {
  if (adventureState.status !== "idle" && adventureState.status !== "completed")
    return;
  // 夜間は時間・コースを制限せず、まだ今回の冒険開始フロー内で注意を確認していない場合だけ
  // 一度注意文を挟む（同じフロー内での再表示はしない。新しい冒険開始時はリセットされる）。
  if (isNightTime() && !adventureState.nightSafetyAcknowledged) {
    showNightWarning();
  } else {
    showDurationPanel();
  }
  logNightModeDebug("begin-adventure-flow");
}

function endAdventure() {
  if (adventureState.status !== "active") return;
  updateAdventureTime();
  adventureState.endedAt = Date.now();
  adventureState.completionData = getAdventureCompletionData();
  stopAdventureTimer();
  clearAdventureFeedbackTimers();
  clearDiscoveryNotification({ flushPendingToast: false });
  setAdventureStatus("completed");
  retireSlopeQuestMarkerForEndOfAdventure();
  showCompletionSheet(adventureState.completionData);
}

/* ---------- 夜間セーフティ ----------
   将来、緯度経度から日没時刻を算出できるよう判定はisNightTime()にまとめる。
   現状は端末のローカル時刻のみを使用（外部の日没API等は導入しない）。 */
function isNightTime(date) {
  const d = date || new Date();
  const h = d.getHours();
  return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
}

let nightWarningReturnFocusEl = null; // 閉じた後に元の操作要素へフォーカスを戻すため保持する

function showNightWarning() {
  nightWarningReturnFocusEl = document.activeElement;
  const panel = el("night-warning-panel");
  panel.classList.remove("hidden");
  const firstBtn = panel.querySelector("button");
  if (firstBtn) firstBtn.focus();
}

function hideNightWarning() {
  el("night-warning-panel").classList.add("hidden");
  if (nightWarningReturnFocusEl && typeof nightWarningReturnFocusEl.focus === "function") {
    nightWarningReturnFocusEl.focus();
  }
  nightWarningReturnFocusEl = null;
}

/* ---------- 冒険時間選択 ---------- */
function renderDurationOptions() {
  ADVENTURE_PRESET_ORDER.forEach((key) => {
    const preset = ADVENTURE_PRESETS[key];
    const btn = document.querySelector(
      `.duration-option[data-preset="${key}"]`,
    );
    if (!btn) return;
    btn.querySelector(".duration-minutes").textContent = `${preset.minutes}分`;
    btn.querySelector(".duration-desc").textContent = preset.label;
  });
}

function showDurationPanel() {
  // 夜間も5分・15分・30分のすべてを選択可能にする（時間制限はしない）。
  setAdventureStatus("choosingDuration");
  const firstOption = document.querySelector(".duration-option");
  if (firstOption) firstOption.focus();
}

function selectAdventurePreset(presetKey) {
  const preset = ADVENTURE_PRESETS[presetKey];
  if (!preset) return;
  clearAdventureFeedbackTimers();
  clearDiscoveryNotification({ flushPendingToast: false });
  stopAdventureTimer();
  adventureState.sessionId++;
  adventureState.preset = presetKey;
  adventureState.direction = null;
  adventureState.directionSelectionMode = null;
  adventureState.startedAt = null;
  adventureState.endedAt = null;
  adventureState.elapsedAdventureMs = 0;
  adventureState.initialTargetDurationMs = preset.targetDurationMs;
  adventureState.startCellId = null;
  adventureState.hasLeftStartCell = false;
  adventureState.goalReached = false;
  adventureState.timeGoalNotificationPending = false;
  adventureState.timeGoalConfettiSuppressed = false;
  adventureState.sessionVisitedCellIds = new Set();
  adventureState.sessionVisitedCells = [];
  adventureState.sessionDiscoveredCellIds = new Set();
  adventureState.sessionDiscoveredCells = [];
  adventureState.distanceMeters = 0;
  adventureState.lastDistancePoint = null;
  adventureState.routePoints = [];
  adventureState.lastRoutePoint = null;
  adventureState.slopeQuestCompleted = false;
  adventureState.slopeQuestNotificationPending = false;
  // 勾配スポット候補は新しい冒険開始時だけリセットする（現在地更新・霧更新・エリア進入では再選定しない）。
  // 前回のフラッグレイヤー・チェック済み表示・保留中のAPI応答も、ここで無効化する。
  adventureState.slopeQuest = {
    status: "idle",
    lat: null,
    lng: null,
    cellId: null,
    score: null,
    requestId: null,
  };
  clearSlopeQuestCompletionTimers();
  if (questLayer) questLayer.clearLayers();
  questMarker = null;
  adventureState.completionData = null;
  adventureState.discoveryFeedbackUntil = 0;
  showDirectionPanel();
}

/* ---------- 道路標識・方向決定UI ----------
   フロンティア・コンパスの方位判定ロジック(computeFrontierDirection)を再利用しつつ、
   回転そのものは pointerup 直前の実測角速度を初速とした摩擦(慣性)物理で駆動する。
   タップ/フリックの強弱が回転速度・回転数・停止時間へ連続的に反映されることが目的。 */
let signSpinning = false;
let signDragState = null; // {center, lastAngle, cumulativeDelta, startRotation, downTime, browserEventCount, coalescedSampleCount, history:[{angle,timestamp}]}
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
  if (
    Number.isFinite(releaseVelocity) &&
    Math.abs(releaseVelocity) >= MIN_DIRECTIONAL_VELOCITY
  ) {
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
    const delta =
      computeFinalRotation(currentRotation, s * 45, dirSign, 0) -
      currentRotation;
    return Math.abs(delta) <= MAX_NATURAL_SNAP_DELTA_DEG;
  });
  const candidates = reachable.length > 0 ? reachable : [natural];
  return {
    natural,
    candidates,
    targetSector: pickWeightedSector(candidates, frontierResult),
  };
}

function getFrontierForSign() {
  const refLatLon =
    lastKnownLatLon || (origin ? { lat: origin.lat0, lon: origin.lon0 } : null);
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
function computeFinalRotation(
  current,
  targetBearingDeg,
  spinSign,
  extraRotations,
) {
  const currentMod = ((current % 360) + 360) % 360;
  const deltaCW = (targetBearingDeg - currentMod + 360) % 360;
  const delta = spinSign >= 0 ? deltaCW : deltaCW === 0 ? 0 : deltaCW - 360;
  return current + spinSign * extraRotations * 360 + delta;
}

function trimPointerHistory(history, now) {
  // 直近 historyWindowMs 分だけを残す。ただし速度算出には最低2点必要なので2点は必ず残す。
  while (
    history.length > 2 &&
    now - history[0].timestamp > SIGN_PHYSICS.historyWindowMs
  ) {
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
  if (sample.pointerId != null && sample.pointerId !== activeSignPointerId)
    return; // 他ポインターのサンプルは無視
  const angle = angleFromCenter(
    sample.clientX,
    sample.clientY,
    signDragState.center,
  );
  if (!Number.isFinite(angle)) return; // 座標異常なサンプルは除外

  const history = signDragState.history;
  const last = history[history.length - 1];
  const rawTimestamp =
    typeof sample.timeStamp === "number" && Number.isFinite(sample.timeStamp)
      ? sample.timeStamp
      : performance.now();

  // 直前と完全に同じ時刻・同じ角度の重複サンプルは追加しない
  if (
    last &&
    rawTimestamp === last.timestamp &&
    angle === signDragState.lastAngle
  )
    return;

  const delta = normalizeAngleDelta(angle - signDragState.lastAngle);
  signDragState.lastAngle = angle;
  signDragState.cumulativeDelta += delta;
  currentSignRotation =
    signDragState.startRotation + signDragState.cumulativeDelta;

  // ノイズ以上の角度移動があれば、そのときの向きを「直前に観測された実際のドラッグ方向」として保持する。
  // releaseVelocityが低速・不正で信頼できない場合の方向決定フォールバックに使う。
  //
  // 1サンプルごとの差分ではなく、最後に方向を確定したチェックポイント(directionRefDelta)からの
  // 累積差分で判定する。getCoalescedEvents()は1回の指の動きを非常に細かい(1サンプルあたり
  // 0.1度未満の)複数サンプルへ分割することがあり、1サンプルごとの差分だけを見ていると
  // 「実際は明確に方向のある動きなのに、どのサンプル単体も閾値未満」となって方向を
  // 見失ってしまうため（低速・微小な反時計回り操作が既定方向へフォールバックしてしまうバグの原因）。
  const deltaSinceDirectionCheckpoint =
    signDragState.cumulativeDelta - signDragState.directionRefDelta;
  if (Math.abs(deltaSinceDirectionCheckpoint) >= MIN_DIRECTION_DELTA_DEG) {
    lastSignDragDirection = Math.sign(deltaSinceDirectionCheckpoint);
    signDragState.directionRefDelta = signDragState.cumulativeDelta;
  }

  // timeStampが逆行した場合は直前値へ丸め、同時刻区間は速度計算側のdt<=0判定で除外する。
  // 架空の微小時間を足すと、指を離す瞬間の小さな戻りが極端な角速度へ増幅されるため。
  const timestamp = last
    ? Math.max(rawTimestamp, last.timestamp)
    : rawTimestamp;
  history.push({ angle: currentSignRotation, timestamp });
}

function onSignPointerDown(e) {
  if (activeSignPointerId !== null && activeSignPointerId !== e.pointerId)
    return; // 複数ポインター同時操作は無視
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
  if (!samples || samples.length < SIGN_RELEASE_VELOCITY.minimumSampleCount)
    return false;
  const span = samples[samples.length - 1].timestamp - samples[0].timestamp;
  return span >= SIGN_RELEASE_VELOCITY.minimumWindowMs;
}

// 直近preferredWindowMs以内のサンプルを優先し、不足していればfallbackWindowMsまで範囲を広げる。
// それでも不十分なら履歴全体を返し、呼び出し側の2点法フォールバックに委ねる。
function selectVelocityWindow(history) {
  if (!history || history.length < 2) return history || [];
  const latestTime = history[history.length - 1].timestamp;
  const preferred = history.filter(
    (s) => latestTime - s.timestamp <= SIGN_RELEASE_VELOCITY.preferredWindowMs,
  );
  if (hasEnoughVelocityData(preferred)) return preferred;
  const fallback = history.filter(
    (s) => latestTime - s.timestamp <= SIGN_RELEASE_VELOCITY.fallbackWindowMs,
  );
  if (hasEnoughVelocityData(fallback)) return fallback;
  return history;
}

// ウィンドウ内での時間的な位置(0=最古側,1=最新側)に応じて、直近の区間ほど重くなる重みを返す。
function calculateRecencyWeight(
  segmentEndTime,
  windowStartTime,
  windowDuration,
) {
  if (windowDuration <= 0) return 1;
  const recency = clamp01((segmentEndTime - windowStartTime) / windowDuration);
  return (
    1 +
    Math.pow(recency, SIGN_RELEASE_VELOCITY.recencyWeightPower) *
      SIGN_RELEASE_VELOCITY.recencyWeightMax
  );
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
    if (
      !Number.isFinite(velocity) ||
      Math.abs(velocity) > SIGN_RELEASE_VELOCITY.maxSegmentVelocity
    )
      continue; // 異常値除外
    const weight = calculateRecencyWeight(
      cur.timestamp,
      windowStartTime,
      windowDuration,
    );
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
    ? weightedAverage * RELEASE_VELOCITY_BLEND.weightedAverageRatio +
      peak * RELEASE_VELOCITY_BLEND.recentPeakRatio
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
    (duration < SIGN_PHYSICS.tapMaxDurationMs ||
      Math.abs(velocityDegPerMs) < SIGN_PHYSICS.minFlickVelocity);
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
    const finalRotation = computeFinalRotation(
      startRotation,
      targetBearingDeg,
      spinSign,
      extra,
    );
    const totalRotation = Math.abs(finalRotation - startRotation);
    return { spinSign, finalRotation, totalRotation };
  });
  const pickClosestToMid = (pool) => {
    pool.sort(
      (a, b) =>
        Math.abs(a.totalRotation - mid) - Math.abs(b.totalRotation - mid),
    );
    return pool[0];
  };
  const inRange = candidates.filter(
    (c) => c.totalRotation >= minDeg && c.totalRotation <= maxDeg,
  );
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

  const duration = randRange(
    SIGN_PHYSICS.tapSpinDurationRangeMs[0],
    SIGN_PHYSICS.tapSpinDurationRangeMs[1],
  );
  logSignDebug("tap-spin", { targetSector, spinSign, plan, duration });
  tweenRotation(startRotation, plan.finalRotation, duration, () =>
    finishSpin(targetSector),
  );
}

function startButtonSpin() {
  if (signDragState) return; // ドラッグ中はボタン操作を無視する
  cancelSignAnimation();
  const spinSign = Math.random() < 0.5 ? -1 : 1;
  logSignDebug("button-spin", {
    spinSign,
    inputVelocity: SIGN_PHYSICS.buttonSpinVelocity,
  });
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
    Math.max(SIGN_PHYSICS.minFlickVelocity, Math.abs(inputVelocityDegPerMs)),
  );
  const normalized = clamp01(
    (clamped - SIGN_PHYSICS.minFlickVelocity) /
      (SIGN_PHYSICS.maxInputVelocity - SIGN_PHYSICS.minFlickVelocity),
  );
  const curved = Math.pow(normalized, SIGN_PHYSICS.velocityCurvePower);
  const spinVelocity =
    SIGN_PHYSICS.minSpinVelocity +
    curved * (SIGN_PHYSICS.maxSpinVelocity - SIGN_PHYSICS.minSpinVelocity);
  // 摩擦も入力強度で補間する（弱い入力ほど速く止まり、強い入力ほど長く/多く回る）。
  const friction =
    SIGN_PHYSICS.frictionPerFrameAt60fpsMin +
    curved *
      (SIGN_PHYSICS.frictionPerFrameAt60fpsMax -
        SIGN_PHYSICS.frictionPerFrameAt60fpsMin);

  logSignDebug("flick-spin-start", {
    inputVelocityDegPerMs,
    spinSign,
    normalized,
    curved,
    spinVelocity,
    friction,
  });
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
      currentSignRotation = Number.isFinite(currentSignRotation)
        ? currentSignRotation
        : 0;
      const dirSign = signedVelocityDegPerMs >= 0 ? 1 : -1;
      const frontier = getFrontierForSign();
      const { targetSector } = pickFlickLandingSector(
        currentSignRotation,
        dirSign,
        frontier,
      );
      const finalRotation = computeFinalRotation(
        currentSignRotation,
        targetSector * 45,
        dirSign,
        0,
      );
      beginOvershootSettle(
        currentSignRotation,
        finalRotation,
        targetSector,
        dirSign,
      );
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
    const overMaxDuration =
      now - inertiaStartTime >= SIGN_PHYSICS.maxSpinDurationMs;

    if (speed <= SIGN_PHYSICS.snapVelocityThreshold || overMaxDuration) {
      const dirSign =
        velocity !== 0
          ? Math.sign(velocity)
          : signedVelocityDegPerMs >= 0
            ? 1
            : -1;
      const frontier = getFrontierForSign();
      const { natural, targetSector } = pickFlickLandingSector(
        currentSignRotation,
        dirSign,
        frontier,
      );
      const finalRotation = computeFinalRotation(
        currentSignRotation,
        targetSector * 45,
        dirSign,
        0,
      );
      logSignDebug("inertia-end", {
        elapsedMs: now - inertiaStartTime,
        natural,
        targetSector,
        finalRotation,
        overMaxDuration,
      });
      if (pendingReleaseDebug) {
        pendingReleaseDebug.spinDurationMs = now - inertiaStartTime;
        pendingReleaseDebug.estimatedRotations =
          Math.abs(currentSignRotation - spinStartRotationForDebug) / 360;
        pendingReleaseDebug.snapDirection = dirSign;
        pendingReleaseDebug.targetAngle = finalRotation;
        logSignReleaseVelocityDebug();
      }
      beginOvershootSettle(
        currentSignRotation,
        finalRotation,
        targetSector,
        dirSign,
      );
      return;
    }

    signAnimationFrameId = requestAnimationFrame(step);
  }

  signAnimationFrameId = requestAnimationFrame(step);
}

function finishReducedMotionSpin(signedVelocityDegPerMs) {
  const dirSign = signedVelocityDegPerMs >= 0 ? 1 : -1;
  const frontier = getFrontierForSign();
  const { targetSector } = pickFlickLandingSector(
    currentSignRotation,
    dirSign,
    frontier,
  );
  // 強さに応じて最大1回転程度まで、短いトランジションで確定する（オーバーシュート・高速回転は行わない）。
  const strength = clamp01(
    Math.abs(signedVelocityDegPerMs) / SIGN_PHYSICS.maxSpinVelocity,
  );
  const rotations = strength > 0.5 ? 1 : 0;
  const finalRotation = computeFinalRotation(
    currentSignRotation,
    targetSector * 45,
    dirSign,
    rotations,
  );
  currentSignRotation = finalRotation;
  applySignRotation(currentSignRotation); // reduced-motion用CSSトランジションで短く遷移する
  logSignDebug("reduced-motion-spin", {
    dirSign,
    targetSector,
    finalRotation,
    strength,
  });
  if (pendingReleaseDebug) {
    pendingReleaseDebug.spinDurationMs = 240;
    pendingReleaseDebug.estimatedRotations =
      Math.abs(currentSignRotation - spinStartRotationForDebug) / 360;
    logSignReleaseVelocityDebug();
  }
  setTimeout(() => finishSpin(targetSector), 240);
}

// 慣性減速の終着点(finalRotation)へ向けて、現在の回転方向を保ったまま
// 数度だけオーバーシュート→小さく戻る、の2段階で自然に吸着させる。
function beginOvershootSettle(
  fromRotation,
  finalRotation,
  targetSector,
  dirSign,
) {
  const overshootRotation = finalRotation + dirSign * SIGN_PHYSICS.overshootDeg;
  tweenRotation(
    fromRotation,
    overshootRotation,
    SIGN_PHYSICS.overshootDurationMs,
    () => {
      tweenRotation(
        overshootRotation,
        finalRotation,
        SIGN_PHYSICS.settleBackDurationMs,
        () => {
          finishSpin(targetSector);
        },
      );
    },
  );
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
  // 地図選択からの確定(spinSignToMapSector)は、この直後に同期的に"map"へ上書きする。
  adventureState.directionSelectionMode = "flick";
  el("direction-result-text").textContent = `今日は${label}へ。`;
  // 夜間は「普段なら選ばない道」を推奨せず、安全な道を選ぶ補足へ差し替える（昼間の文言は変更しない）。
  el("direction-result-sub").textContent = isNightTime()
    ? NIGHT_DIRECTION_SUB_TEXT[adventureState.preset] || NIGHT_DIRECTION_SUB_TEXT.normal
    : "最初の200〜300mだけ、この方向を意識してみよう。";
  el("direction-result").classList.remove("hidden");
  // #sign-boardはaria-hiddenな視覚要素なので、読み上げ用にsr-onlyのライブリージョンへ結果を通知する。
  el("sign-sr-status").textContent = `方角が決まりました。今日は${label}へ。`;
  const confirmBtn = el("btn-confirm-direction");
  if (confirmBtn) confirmBtn.focus();
  logNightModeDebug("sign-settled");
}

function showDirectionPanel() {
  setAdventureStatus("choosingDirection");
  el("direction-result").classList.add("hidden");
  el("direction-hint").textContent = isNightTime()
    ? "明るく、人通りのある道を選んでください。標識をはじいて方角を決めよう。"
    : "標識をはじいて、今日進む方角を決めよう。";
  el("sign-sr-status").textContent =
    "まだ方角は決まっていません。標識を回すボタンで方角を決められます。";
  // パネルを開くたびに標識の操作状態を安全にリセットする
  cancelSignAnimation();
  activeSignPointerId = null;
  signDragState = null;
}

function redoDirection() {
  el("direction-result").classList.add("hidden");
  adventureState.direction = null;
  adventureState.directionSelectionMode = null;
  el("sign-sr-status").textContent =
    "方角をやり直します。もう一度、標識を回すボタンを押してください。";
  const spinBtn = el("btn-spin-sign");
  if (spinBtn) spinBtn.focus();
}

function confirmDirection() {
  if (!adventureState.direction) return;
  adventureState.startedAt = Date.now();
  adventureState.endedAt = null;
  adventureState.elapsedAdventureMs = 0;
  adventureState.startLatLon = lastReliablePosition
    ? { lat: lastReliablePosition.lat, lon: lastReliablePosition.lon }
    : lastKnownLatLon
      ? { ...lastKnownLatLon }
      : null;
  adventureState.startCellId = lastReliableCellId;
  adventureState.currentCellId = lastReliableCellId;
  adventureState.lastDistancePoint = lastReliablePosition
    ? { ...lastReliablePosition }
    : null;
  // ルート記録は冒険開始の瞬間からにする（時間選択中・標識操作中は記録しない）。
  // 現在の有効GPS位置があれば開始点として1点目に加える（distanceMetersと同じ考え方）。
  adventureState.routePoints = [];
  adventureState.lastRoutePoint = null;
  if (lastReliablePosition) {
    const startRoutePoint = {
      lat: lastReliablePosition.lat,
      lon: lastReliablePosition.lon,
      timestamp: Number.isFinite(lastReliablePosition.timestamp)
        ? lastReliablePosition.timestamp
        : Date.now(),
      accuracy: null,
      cumulativeDistanceM: 0,
    };
    adventureState.routePoints.push(startRoutePoint);
    adventureState.lastRoutePoint = startRoutePoint;
  }
  compassState = "collapsed";
  renderCompass();
  setAdventureStatus("active");
  renderAdventureHud();
  startAdventureTimer();
  showToast(`${adventureState.direction.label}へ冒険開始！`);
  logTimeGoalDebug("adventure-started");
}

/* ==========================================================
   地図を見て方向を選ぶ補助モード
   標識フリックが主役の体験であることは変えず、行き先のイメージはあるが
   それがどの方角か分からないユーザーのための補助手段として追加する。
   経路案内・目的地設定ではなく、あくまで8方位を1つ選ぶための一時的な操作。
   タップ地点の緯度経度は方向確定後に保持しない（保存するのは8方位と選択方法のみ）。
   ========================================================== */
let mapDirectionModeActive = false;
let mapDirectionSelectedLatLon = null; // {lat, lon} 一時的な選択点。確定・モード終了で必ずnullへ戻す
let mapDirectionBearingDeg = null;
let mapDirectionSector = null;
let mapDirectionLineLayer = null;
let mapDirectionPointMarker = null;
let mapDirectionReturnFocusEl = null; // 「標識に戻る」時にフォーカスを戻す先

function buildMapDirectionPointIconHtml() {
  return `<span class="map-direction-point__glow"></span><span class="map-direction-point__arrow"></span>`;
}

// GPS現在地(reliableな最新値。無ければ直近の既知位置)を返す。地図の表示中心(パン後の地図中央)は使わない。
function getCurrentPositionForMapDirection() {
  if (lastReliablePosition) {
    return { lat: lastReliablePosition.lat, lon: lastReliablePosition.lon };
  }
  if (lastKnownLatLon) return { ...lastKnownLatLon };
  return null;
}

// computeFrontierDirection()と同じ「ローカル平面座標(toMeters)上のatan2」方式に合わせ、
// 標識フリックで確定する方向(adventureState.direction)と同じsector/bearingDeg形式で返す。
function computeMapDirectionBearing(curLat, curLon, targetLat, targetLon) {
  const curXY = toMeters(curLat, curLon);
  const targetXY = toMeters(targetLat, targetLon);
  const bearingDeg =
    ((Math.atan2(targetXY.x - curXY.x, targetXY.y - curXY.y) * 180) / Math.PI +
      360) %
    360;
  const sector = Math.round(bearingDeg / 45) % 8;
  return { bearingDeg, sector };
}

// 「地図を見て方向を決める」ボタンの入口。現在地が既にあれば即座にモードを開く。
// 万一まだ無い場合だけ、押した後に一度取得を試みる（取得中/失敗の文言を表示）。
function openMapDirectionMode() {
  if (mapDirectionModeActive) return;
  const currentPos = getCurrentPositionForMapDirection();
  if (currentPos) {
    enterMapDirectionMode(currentPos);
    return;
  }
  if (!("geolocation" in navigator)) {
    showToast("現在地を確認できませんでした。標識をはじいて方向を決めることもできます。");
    return;
  }
  showToast("現在地を確認しています");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const p = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      lastKnownLatLon = { ...p };
      enterMapDirectionMode(p);
    },
    () => {
      showToast("現在地を確認できませんでした。標識をはじいて方向を決めることもできます。");
    },
    { timeout: 8000, maximumAge: 10000 },
  );
}

function enterMapDirectionMode(currentPos) {
  mapDirectionModeActive = true;
  mapDirectionSelectedLatLon = null;
  mapDirectionBearingDeg = null;
  mapDirectionSector = null;
  mapDirectionReturnFocusEl = document.activeElement;

  el("direction-panel").classList.add("hidden");
  el("hud").classList.add("hidden"); // ログ等の操作と重ならないよう、選択中は上部HUDを隠す
  el("map-direction-hint").textContent = "行きたい方向を地図で選んでください";
  el("map-direction-selected").classList.add("hidden");
  el("btn-map-direction-confirm").disabled = true;
  el("map-direction-sr-status").textContent =
    "行きたい方向を地図で選んでください。地図をタップすると方角が決まります。";
  el("map-direction-panel").classList.remove("hidden");

  if (map) {
    map.setView([currentPos.lat, currentPos.lon], MAP_DIRECTION_INITIAL_ZOOM, {
      animate: !prefersReducedMotion(),
    });
    map.on("click", handleMapDirectionTap);
  }
  const backBtn = el("btn-map-direction-back");
  if (backBtn) backBtn.focus();
}

// 地図タップ・勾配スポット旗タップの両方から呼ばれる共通入口。
// 旗をタップしても目的地確定はしない（openQuestPanelを呼ばず、通常のタップと同様に方角だけ示す）。
function handleMapDirectionTap(e) {
  if (!mapDirectionModeActive || !e || !e.latlng) return;
  const currentPos = getCurrentPositionForMapDirection();
  if (!currentPos) return; // 現在地が無い状態では選択を進めない安全装置
  const lat = e.latlng.lat;
  const lon = e.latlng.lng;
  mapDirectionSelectedLatLon = { lat, lon };
  const { bearingDeg, sector } = computeMapDirectionBearing(
    currentPos.lat,
    currentPos.lon,
    lat,
    lon,
  );
  mapDirectionBearingDeg = bearingDeg;
  mapDirectionSector = sector;
  renderMapDirectionSelection(currentPos, { lat, lon }, bearingDeg, sector);
}

// 現在地→タップ地点の方向線・矢印を描画/更新する。経路ではなくただの直線で、道には沿わせない。
function renderMapDirectionSelection(currentPos, tapPos, bearingDeg, sector) {
  const label = COMPASS_LABELS[sector];

  const latlngs = [
    [currentPos.lat, currentPos.lon],
    [tapPos.lat, tapPos.lon],
  ];
  if (mapDirectionLineLayer) {
    mapDirectionLineLayer.setLatLngs(latlngs);
  } else {
    mapDirectionLineLayer = L.polyline(latlngs, {
      pane: "mapDirectionPane",
      renderer: mapDirectionRenderer,
      className: "map-direction-line",
      color: "#fbbf24",
      weight: 2,
      opacity: 0.75,
      interactive: false,
    }).addTo(map);
  }

  if (mapDirectionPointMarker) {
    mapDirectionPointMarker.setLatLng([tapPos.lat, tapPos.lon]);
  } else {
    const icon = L.divIcon({
      className: "map-direction-point",
      html: buildMapDirectionPointIconHtml(),
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    mapDirectionPointMarker = L.marker([tapPos.lat, tapPos.lon], {
      pane: "mapDirectionPane",
      icon,
      interactive: false,
    }).addTo(map);
  }
  // 矢印は8方位への丸め前、実際に線が向いている角度(bearingDeg)へ合わせる（線とのズレを防ぐ）
  const pointEl = mapDirectionPointMarker.getElement();
  const arrow = pointEl ? pointEl.querySelector(".map-direction-point__arrow") : null;
  if (arrow) arrow.style.transform = `rotate(${bearingDeg}deg)`;

  el("map-direction-hint").textContent =
    "この方角を目安に、安全な道を選んでください";
  el("map-direction-selected-text").textContent = label;
  el("map-direction-selected").classList.remove("hidden");
  el("btn-map-direction-confirm").disabled = false;
  el("map-direction-sr-status").textContent = `この方向へ ${label}`;
}

// ズームは変えず、現在地を中央付近へ戻すだけ。選択中の方角・線・タップ地点は維持する。
function recenterMapDirection() {
  if (!map) return;
  const currentPos = getCurrentPositionForMapDirection();
  if (!currentPos) return;
  map.setView([currentPos.lat, currentPos.lon], map.getZoom(), {
    animate: !prefersReducedMotion(),
  });
}

// モードを閉じる共通処理。確定・戻る操作どちらからも呼ばれ、選択点・方向線・一時状態を必ずクリアする
// （前回の選択が次回のモード起動へ残らないようにするため）。
function closeMapDirectionOverlay() {
  mapDirectionModeActive = false;
  mapDirectionSelectedLatLon = null;
  mapDirectionBearingDeg = null;
  mapDirectionSector = null;
  if (map) {
    map.off("click", handleMapDirectionTap);
    if (mapDirectionLineLayer) {
      map.removeLayer(mapDirectionLineLayer);
      mapDirectionLineLayer = null;
    }
    if (mapDirectionPointMarker) {
      map.removeLayer(mapDirectionPointMarker);
      mapDirectionPointMarker = null;
    }
  }
  el("map-direction-panel").classList.add("hidden");
  el("hud").classList.remove("hidden");
}

// 「標識に戻る」。方向は確定せず、標識の状態(既存のadventureState.direction/回転)は一切変更しない。
function cancelMapDirectionMode() {
  if (!mapDirectionModeActive) return;
  closeMapDirectionOverlay();
  el("direction-panel").classList.remove("hidden");
  const spinBtn = el("btn-spin-sign");
  if (spinBtn) {
    spinBtn.focus();
  } else if (
    mapDirectionReturnFocusEl &&
    typeof mapDirectionReturnFocusEl.focus === "function"
  ) {
    mapDirectionReturnFocusEl.focus();
  }
}

// 「この方向にする」。モードを閉じ、標識画面へ戻した上で、標識を選んだ方角へ短く回してから
// 通常の方向確定(onSignSettled→#direction-result表示)と合流させる。冒険はまだ開始しない。
function confirmMapDirection() {
  if (!mapDirectionModeActive || mapDirectionSector == null) return;
  const sector = mapDirectionSector;
  closeMapDirectionOverlay();
  el("direction-panel").classList.remove("hidden");
  el("direction-result").classList.add("hidden");
  spinSignToMapSector(sector);
}

// 標識フリックの物理演算は使わず、現在の角度から選択方角へ最短距離で短く回すだけの単純な遷移。
// 完了後はfinishSpin()→onSignSettled()という既存の確定処理へそのまま合流させる。
function spinSignToMapSector(sector) {
  cancelSignAnimation();
  signSpinning = true;
  el("sign-board").classList.add("spinning");

  const startRotation = currentSignRotation;
  const targetBearingDeg = sector * 45;
  const currentMod = ((startRotation % 360) + 360) % 360;
  const shortestDelta = ((targetBearingDeg - currentMod + 540) % 360) - 180;
  const finalRotation = startRotation + shortestDelta;

  const settle = () => {
    finishSpin(sector); // 内部でonSignSettled(sector)を呼び、directionSelectionModeを"flick"にする
    adventureState.directionSelectionMode = "map"; // 地図選択由来のため直後に上書きする
  };

  if (prefersReducedMotion()) {
    currentSignRotation = finalRotation;
    applySignRotation(currentSignRotation);
    settle();
    return;
  }
  tweenRotation(startRotation, finalRotation, MAP_DIRECTION_SIGN_SPIN_MS, settle);
}

/* ---------- セル発見リアクション ----------
   将来SEを追加しやすいよう、視覚・文言・振動のリアクションを一箇所にまとめる。 */
function shouldTriggerInitialAdventureGoal({
  elapsedAdventureMs,
  initialTargetDurationMs,
  goalReached,
}) {
  return (
    !goalReached &&
    Number.isFinite(elapsedAdventureMs) &&
    Number.isFinite(initialTargetDurationMs) &&
    initialTargetDurationMs > 0 &&
    elapsedAdventureMs >= initialTargetDurationMs
  );
}

function getTimeGoalMessageTiming(reducedMotion) {
  return {
    fadeInMs: reducedMotion
      ? TIME_GOAL_MESSAGE_TIMING.reducedFadeInMs
      : TIME_GOAL_MESSAGE_TIMING.fadeInMs,
    holdMs: TIME_GOAL_MESSAGE_TIMING.holdMs,
    fadeOutMs: reducedMotion
      ? TIME_GOAL_MESSAGE_TIMING.reducedFadeOutMs
      : TIME_GOAL_MESSAGE_TIMING.fadeOutMs,
  };
}

function getTimeGoalPresentationDelay(now) {
  const currentTime = Number.isFinite(now) ? now : Date.now();
  return Math.max(
    TIME_GOAL_PRESENTATION_DELAY_MS,
    adventureState.discoveryFeedbackUntil - currentTime,
  );
}

function hideTimeGoalNotification() {
  const notification = el("time-goal-notification");
  if (!notification) return;
  notification.classList.remove("is-visible");
  notification.classList.add("hidden");
}

function shouldSuppressTimeGoalConfettiForDiscovery() {
  return (
    discoveryNotificationState.phase === "milestone" ||
    discoveryNotificationState.milestoneThreshold != null
  );
}

function showTimeGoalNotification() {
  if (
    adventureState.status !== "active" ||
    !adventureState.goalReached ||
    !adventureState.timeGoalNotificationPending
  ) {
    return false;
  }

  const notification = el("time-goal-notification");
  if (!notification) return false;
  const timing = getTimeGoalMessageTiming(prefersReducedMotion());
  const sessionId = adventureState.sessionId;
  adventureState.timeGoalNotificationPending = false;
  notification.textContent = ADVENTURE_GOAL_MESSAGE;
  notification.classList.remove("hidden", "is-visible");
  notification.style.setProperty("--time-goal-transition-ms", `${timing.fadeInMs}ms`);
  void notification.offsetWidth;
  notification.classList.add("is-visible");

  if (!adventureState.timeGoalConfettiSuppressed) {
    spawnConfetti(TIME_GOAL_COMPLETION_EFFECT);
  }

  scheduleAdventureFeedbackAction(sessionId, timing.fadeInMs + timing.holdMs, () => {
    notification.style.setProperty(
      "--time-goal-transition-ms",
      `${timing.fadeOutMs}ms`,
    );
    notification.classList.remove("is-visible");
    scheduleAdventureFeedbackAction(sessionId, timing.fadeOutMs, () => {
      notification.classList.add("hidden");
    });
  });
  logTimeGoalDebug("time-goal-presented", { timeGoalTriggered: true });
  return true;
}

function scheduleTimeGoalPresentation() {
  if (!adventureState.timeGoalNotificationPending) return false;
  const sessionId = adventureState.sessionId;
  clearAdventureFeedbackTimers();
  const attemptPresentation = () => {
    if (
      adventureState.status !== "active" ||
      !adventureState.goalReached ||
      !adventureState.timeGoalNotificationPending ||
      adventureState.sessionId !== sessionId
    ) {
      return;
    }

    if (
      typeof document.visibilityState === "string" &&
      document.visibilityState !== "visible"
    ) {
      // バックグラウンド中は表示時間を消費せず、復帰時のvisibilitychangeで再予約する。
      return;
    }

    const delayMs = getTimeGoalPresentationDelay();
    if (
      isDiscoveryNotificationActive() ||
      delayMs > TIME_GOAL_PRESENTATION_DELAY_MS
    ) {
      scheduleAdventureFeedbackAction(
        sessionId,
        delayMs + TIME_GOAL_PRESENTATION_DELAY_MS,
        attemptPresentation,
      );
      return;
    }

    showTimeGoalNotification();
  };

  scheduleAdventureFeedbackAction(
    sessionId,
    getTimeGoalPresentationDelay(),
    attemptPresentation,
  );
  return true;
}

function triggerAdventureTimeGoal() {
  if (
    !shouldTriggerInitialAdventureGoal({
      elapsedAdventureMs: adventureState.elapsedAdventureMs,
      initialTargetDurationMs: adventureState.initialTargetDurationMs,
      goalReached: adventureState.goalReached,
    })
  ) {
    return false;
  }

  // 表示より先に立て、インターバル復帰やGPS更新による二重実行を防ぐ。
  adventureState.goalReached = true;
  adventureState.timeGoalNotificationPending = true;
  adventureState.timeGoalConfettiSuppressed =
    shouldSuppressTimeGoalConfettiForDiscovery();
  renderAdventureHud();
  scheduleTimeGoalPresentation();
  logTimeGoalDebug("time-goal-triggered", { timeGoalTriggered: true });
  return true;
}

function handleAdventureVisibilityChange() {
  if (document.visibilityState !== "visible") return;
  const notificationWasPending = adventureState.timeGoalNotificationPending;
  updateAdventureTime();
  if (notificationWasPending && adventureState.timeGoalNotificationPending) {
    scheduleTimeGoalPresentation();
  }
}

function deferTimeGoalNotificationForDiscovery(milestoneThreshold) {
  if (adventureState.status !== "active" || !adventureState.goalReached) {
    return false;
  }

  const notification = el("time-goal-notification");
  const isVisible =
    notification && notification.classList.contains("is-visible");
  if (!isVisible && !adventureState.timeGoalNotificationPending) return false;

  if (milestoneThreshold != null || isVisible) {
    // 節目の紙吹雪を優先する。表示済み通知を発見が中断した場合も再紙吹雪は出さない。
    adventureState.timeGoalConfettiSuppressed = true;
  }
  if (isVisible) {
    adventureState.timeGoalNotificationPending = true;
    hideTimeGoalNotification();
  }
  scheduleTimeGoalPresentation();
  return true;
}

function registerAdventureVisitedCell(ix, iy) {
  if (adventureState.status !== "active") return false;
  const key = cellKey(ix, iy);
  adventureState.currentCellId = key;

  if (!adventureState.startCellId) {
    adventureState.startCellId = key;
    return false;
  }

  if (key === adventureState.startCellId && !adventureState.hasLeftStartCell) {
    return false;
  }

  if (key !== adventureState.startCellId) {
    adventureState.hasLeftStartCell = true;
  }

  if (adventureState.sessionVisitedCellIds.has(key)) return false;
  adventureState.sessionVisitedCellIds.add(key);
  adventureState.sessionVisitedCells.push({ ix, iy });
  renderAdventureHud();
  return true;
}

function registerAdventureDistance(lat, lon, timestamp, accuracy) {
  if (adventureState.status !== "active") return false;
  if (Number.isFinite(accuracy) && accuracy > DISTANCE_MAX_ACCURACY_M) {
    return false;
  }
  const currentPoint = {
    lat,
    lon,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
  };
  const previousPoint = adventureState.lastDistancePoint;
  if (!previousPoint) {
    adventureState.lastDistancePoint = currentPoint;
    return false;
  }

  const stepMeters = haversineMeters(
    previousPoint.lat,
    previousPoint.lon,
    currentPoint.lat,
    currentPoint.lon,
  );
  const elapsedSeconds = Math.max(
    0,
    (currentPoint.timestamp - previousPoint.timestamp) / 1000,
  );
  const speedMps = elapsedSeconds > 0 ? stepMeters / elapsedSeconds : Infinity;
  const isValidStep =
    Number.isFinite(stepMeters) &&
    stepMeters >= DISTANCE_MIN_STEP_M &&
    stepMeters <= DISTANCE_MAX_STEP_M &&
    speedMps <= DISTANCE_MAX_SPEED_MPS;

  if (!isValidStep) {
    // 外れ値そのものは加算しないが、次の正常点で復帰できるよう基準点だけ更新する。
    if (
      stepMeters > DISTANCE_MAX_STEP_M ||
      (elapsedSeconds > 0 && speedMps > DISTANCE_MAX_SPEED_MPS)
    ) {
      adventureState.lastDistancePoint = currentPoint;
    }
    return false;
  }
  adventureState.distanceMeters += stepMeters;
  adventureState.lastDistancePoint = currentPoint;
  return true;
}

// 冒険中のGPS点のうち、終了画面の「今日歩いた形」用に残す点だけを間引いて保存する。
// 精度・速度・ジャンプの判定基準はregisterAdventureDistance()と揃えているが、
// 「保存するかどうか」はこちらだけの記録間隔(ROUTE_RECORDING_CONFIG)で決める。
function recordRoutePoint(lat, lon, timestamp, accuracy) {
  if (adventureState.status !== "active") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (
    Number.isFinite(accuracy) &&
    accuracy > ROUTE_RECORDING_CONFIG.maxAccuracyM
  ) {
    return false;
  }
  const ts = Number.isFinite(timestamp) ? timestamp : Date.now();
  const safeAccuracy = Number.isFinite(accuracy) ? accuracy : null;

  const previous = adventureState.lastRoutePoint;
  if (!previous) {
    const point = { lat, lon, timestamp: ts, accuracy: safeAccuracy, cumulativeDistanceM: 0 };
    adventureState.routePoints.push(point);
    adventureState.lastRoutePoint = point;
    return true;
  }

  const stepMeters = haversineMeters(previous.lat, previous.lon, lat, lon);
  if (!Number.isFinite(stepMeters)) return false;

  const elapsedSeconds = Math.max(0, (ts - previous.timestamp) / 1000);
  const speedMps = elapsedSeconds > 0 ? stepMeters / elapsedSeconds : Infinity;
  const isJump =
    stepMeters > ROUTE_RECORDING_CONFIG.maxSegmentDistanceM ||
    (elapsedSeconds > 0 && speedMps > ROUTE_RECORDING_CONFIG.maxSpeedMps);

  if (isJump) {
    // registerAdventureDistance()と違い、基準点は進めない。
    // ここで基準点をジャンプ先へ進めてしまうと、GPSが元の場所へ自己修正した後の
    // 正常な一歩が「ジャンプ先からの小さな移動」として採用されてしまい、形状全体の
    // 縮尺がジャンプ先まで含めて引き伸ばされる（線が極端に縮んで見える）。
    // 基準点を据え置くことで、GPSが元の位置付近へ戻った時点で自然に復帰できる。
    return false;
  }

  const elapsedSincePreviousMs = ts - previous.timestamp;
  const shouldRecord =
    stepMeters >= ROUTE_RECORDING_CONFIG.minDistanceM ||
    (elapsedSincePreviousMs >= ROUTE_RECORDING_CONFIG.maxIntervalMs &&
      stepMeters >= ROUTE_RECORDING_CONFIG.minIntervalDistanceM);
  if (!shouldRecord) return false;

  const point = {
    lat,
    lon,
    timestamp: ts,
    accuracy: safeAccuracy,
    cumulativeDistanceM: previous.cumulativeDistanceM + stepMeters,
  };
  adventureState.routePoints.push(point);
  adventureState.lastRoutePoint = point;

  if (adventureState.routePoints.length > ROUTE_RECORDING_CONFIG.maxPoints) {
    thinRoutePoints();
  }
  return true;
}

// 点数が上限を超えたら、開始点(先頭)を残しつつ2点に1点へ間引く。記録自体は止めない。
function thinRoutePoints() {
  const points = adventureState.routePoints;
  if (points.length === 0) return;
  const thinned = [points[0]];
  for (let i = 1; i < points.length; i += 2) {
    thinned.push(points[i]);
  }
  adventureState.routePoints = thinned;
}

function registerAdventureDiscovery(ix, iy) {
  if (adventureState.status !== "active") return false;
  const key = cellKey(ix, iy);

  if (adventureState.sessionDiscoveredCellIds.has(key)) return false;

  adventureState.sessionDiscoveredCellIds.add(key);
  adventureState.sessionDiscoveredCells.push({ ix, iy });
  return true;
}

const discoveryNotificationState = {
  token: 0,
  phase: "idle", // idle | waiting | first | milestone | second
  sessionId: null,
  latestCount: null,
  milestoneThreshold: null,
  phaseEndsAt: 0,
  timerId: null,
};

function getDiscoveryMessageTiming(reducedMotion) {
  const shortFadeMs = DISCOVERY_MESSAGE_TIMING.reducedFadeInMs;
  const shortFadeOutMs = DISCOVERY_MESSAGE_TIMING.reducedFadeOutMs;
  return {
    firstFadeInMs: reducedMotion
      ? shortFadeMs
      : DISCOVERY_MESSAGE_TIMING.firstFadeInMs,
    firstHoldMs: DISCOVERY_MESSAGE_TIMING.firstHoldMs,
    firstFadeOutMs: reducedMotion
      ? shortFadeOutMs
      : DISCOVERY_MESSAGE_TIMING.firstFadeOutMs,
    secondFadeInMs: reducedMotion
      ? shortFadeMs
      : DISCOVERY_MESSAGE_TIMING.secondFadeInMs,
    secondHoldMs: DISCOVERY_MESSAGE_TIMING.secondHoldMs,
    secondFadeOutMs: reducedMotion
      ? shortFadeOutMs
      : DISCOVERY_MESSAGE_TIMING.secondFadeOutMs,
    milestoneFadeInMs: reducedMotion
      ? shortFadeMs
      : MILESTONE_MESSAGE_TIMING.fadeInMs,
    milestoneHoldMs: MILESTONE_MESSAGE_TIMING.holdMs,
    milestoneFadeOutMs: reducedMotion
      ? shortFadeOutMs
      : MILESTONE_MESSAGE_TIMING.fadeOutMs,
  };
}

function getDiscoveryPhaseDurationMs(fadeInMs, holdMs, fadeOutMs) {
  return Math.max(0, fadeInMs) + Math.max(0, holdMs) + Math.max(0, fadeOutMs);
}

function isDiscoveryNotificationActive() {
  return discoveryNotificationState.phase !== "idle";
}

function clearDiscoveryNotificationTimer() {
  if (discoveryNotificationState.timerId != null) {
    clearTimeout(discoveryNotificationState.timerId);
    discoveryNotificationState.timerId = null;
  }
}

function hideDiscoveryMessage() {
  const message = el("discovery-message");
  if (!message) return;
  message.classList.remove("is-visible");
  message.classList.add("hidden");
}

function flushPendingToast() {
  const pending = showToast._pending;
  showToast._pending = null;
  if (pending) showToast(pending.msg, pending.variant);
}

function clearDiscoveryNotification(options) {
  const flushPending = !options || options.flushPendingToast !== false;
  clearDiscoveryNotificationTimer();
  discoveryNotificationState.token += 1;
  discoveryNotificationState.phase = "idle";
  discoveryNotificationState.sessionId = null;
  discoveryNotificationState.latestCount = null;
  discoveryNotificationState.milestoneThreshold = null;
  discoveryNotificationState.phaseEndsAt = 0;
  hideDiscoveryMessage();
  if (flushPending) {
    flushPendingToast();
  } else {
    showToast._pending = null;
  }
}

function scheduleDiscoveryNotificationAction(delayMs, action) {
  clearDiscoveryNotificationTimer();
  const token = discoveryNotificationState.token;
  discoveryNotificationState.timerId = setTimeout(() => {
    discoveryNotificationState.timerId = null;
    if (token !== discoveryNotificationState.token) return;
    action();
  }, Math.max(0, delayMs));
}

function getRemainingDiscoveryNotificationMs(now) {
  if (!isDiscoveryNotificationActive()) return 0;
  const timing = getDiscoveryMessageTiming(prefersReducedMotion());
  const currentTime = Number.isFinite(now) ? now : Date.now();
  const currentPhaseMs = Math.max(
    0,
    discoveryNotificationState.phaseEndsAt - currentTime,
  );
  const firstMs = getDiscoveryPhaseDurationMs(
    timing.firstFadeInMs,
    timing.firstHoldMs,
    timing.firstFadeOutMs,
  );
  const secondMs =
    discoveryNotificationState.latestCount == null
      ? 0
      : getDiscoveryPhaseDurationMs(
          timing.secondFadeInMs,
          timing.secondHoldMs,
          timing.secondFadeOutMs,
        );
  const milestoneMs =
    discoveryNotificationState.milestoneThreshold == null
      ? 0
      : getDiscoveryPhaseDurationMs(
          timing.milestoneFadeInMs,
          timing.milestoneHoldMs,
          timing.milestoneFadeOutMs,
        );

  if (discoveryNotificationState.phase === "waiting") {
    return currentPhaseMs + firstMs + milestoneMs + secondMs;
  }
  if (discoveryNotificationState.phase === "first") {
    return currentPhaseMs + milestoneMs + secondMs;
  }
  if (discoveryNotificationState.phase === "milestone") {
    return currentPhaseMs + secondMs;
  }
  return currentPhaseMs;
}

function refreshDiscoveryFeedbackDeadline() {
  const sessionId = discoveryNotificationState.sessionId;
  if (
    sessionId == null ||
    adventureState.status !== "active" ||
    adventureState.sessionId !== sessionId
  ) {
    return;
  }
  adventureState.discoveryFeedbackUntil = Math.max(
    adventureState.discoveryFeedbackUntil,
    Date.now() + getRemainingDiscoveryNotificationMs(),
  );
}

function runDiscoveryMessagePhase({
  phase,
  text,
  variant,
  fadeInMs,
  holdMs,
  fadeOutMs,
  onComplete,
}) {
  clearDiscoveryNotificationTimer();
  discoveryNotificationState.phase = phase;
  discoveryNotificationState.phaseEndsAt =
    Date.now() + getDiscoveryPhaseDurationMs(fadeInMs, holdMs, fadeOutMs);

  const message = el("discovery-message");
  if (message) {
    message.classList.remove(
      "hidden",
      "is-visible",
      "discovery-primary",
      "discovery-secondary",
      "discovery-milestone",
    );
    message.classList.add(`discovery-${variant}`);
    message.style.setProperty("--discovery-transition-ms", `${fadeInMs}ms`);
    message.textContent = text;
    // 初期opacityを確定してから表示クラスを付け、短いフェードを確実に開始する。
    void message.offsetWidth;
    message.classList.add("is-visible");
  }

  refreshDiscoveryFeedbackDeadline();
  scheduleDiscoveryNotificationAction(fadeInMs + holdMs, () => {
    if (message) {
      message.style.setProperty("--discovery-transition-ms", `${fadeOutMs}ms`);
      message.classList.remove("is-visible");
    }
    scheduleDiscoveryNotificationAction(fadeOutMs, () => {
      if (message) message.classList.add("hidden");
      onComplete();
    });
  });
}

function finishDiscoveryNotification() {
  clearDiscoveryNotification({ flushPendingToast: true });
  // 優先順位: 発見通知＞累計節目＞勾配スポット到達＞時間達成。
  if (adventureState.slopeQuestNotificationPending) {
    showSlopeQuestNotification();
  }
  if (adventureState.timeGoalNotificationPending) {
    scheduleTimeGoalPresentation();
  }
}

function startSecondDiscoveryMessage() {
  const count = discoveryNotificationState.latestCount;
  if (count == null) {
    finishDiscoveryNotification();
    return;
  }
  const timing = getDiscoveryMessageTiming(prefersReducedMotion());
  runDiscoveryMessagePhase({
    phase: "second",
    text: `今日の発見 ${count}`,
    variant: "secondary",
    fadeInMs: timing.secondFadeInMs,
    holdMs: timing.secondHoldMs,
    fadeOutMs: timing.secondFadeOutMs,
    onComplete: finishDiscoveryNotification,
  });
}

function startMilestoneDiscoveryMessage(threshold) {
  discoveryNotificationState.milestoneThreshold = null;
  const timing = getDiscoveryMessageTiming(prefersReducedMotion());
  const text = showMilestoneCelebration(threshold, { showToast: false });
  runDiscoveryMessagePhase({
    phase: "milestone",
    text,
    variant: "milestone",
    fadeInMs: timing.milestoneFadeInMs,
    holdMs: timing.milestoneHoldMs,
    fadeOutMs: timing.milestoneFadeOutMs,
    onComplete: startSecondDiscoveryMessage,
  });
}

function continueDiscoveryMessageAfterFirst() {
  const threshold = discoveryNotificationState.milestoneThreshold;
  if (threshold != null) {
    startMilestoneDiscoveryMessage(threshold);
  } else {
    startSecondDiscoveryMessage();
  }
}

function startFirstDiscoveryMessage() {
  const timing = getDiscoveryMessageTiming(prefersReducedMotion());
  runDiscoveryMessagePhase({
    phase: "first",
    text: "新しい場所を発見！",
    variant: "primary",
    fadeInMs: timing.firstFadeInMs,
    holdMs: timing.firstHoldMs,
    fadeOutMs: timing.firstFadeOutMs,
    onComplete: continueDiscoveryMessageAfterFirst,
  });
}

function queueDiscoveryNotification({
  sessionId,
  sessionDiscoveryCount,
  milestoneThreshold,
}) {
  const sameSequence =
    isDiscoveryNotificationActive() &&
    discoveryNotificationState.sessionId === sessionId;

  if (sameSequence) {
    if (sessionDiscoveryCount != null) {
      discoveryNotificationState.latestCount = sessionDiscoveryCount;
    }
    if (milestoneThreshold != null) {
      discoveryNotificationState.milestoneThreshold = milestoneThreshold;
    }

    // 第2表示中の新規発見は最新値で短く再開する。節目は先に差し込む。
    if (
      discoveryNotificationState.phase === "second" &&
      discoveryNotificationState.milestoneThreshold != null
    ) {
      startMilestoneDiscoveryMessage(
        discoveryNotificationState.milestoneThreshold,
      );
    } else if (discoveryNotificationState.phase === "second") {
      startSecondDiscoveryMessage();
    } else if (
      discoveryNotificationState.phase === "milestone" &&
      discoveryNotificationState.milestoneThreshold != null
    ) {
      // 連続して節目を越えても配列へ積まず、最新の節目だけへ更新する。
      startMilestoneDiscoveryMessage(
        discoveryNotificationState.milestoneThreshold,
      );
    } else {
      refreshDiscoveryFeedbackDeadline();
    }
    return;
  }

  clearDiscoveryNotification({ flushPendingToast: false });
  discoveryNotificationState.sessionId = sessionId;
  discoveryNotificationState.latestCount = sessionDiscoveryCount;
  discoveryNotificationState.milestoneThreshold = milestoneThreshold;
  discoveryNotificationState.phase = "waiting";
  const fogDelayMs = prefersReducedMotion()
    ? 0
    : CELL_FOG_CONFIG.revealDurationMs;
  discoveryNotificationState.phaseEndsAt = Date.now() + fogDelayMs;

  const toast = el("toast");
  if (toast) {
    clearTimeout(showToast._timer);
    toast.classList.add("hidden");
  }
  refreshDiscoveryFeedbackDeadline();
  scheduleDiscoveryNotificationAction(fogDelayMs, startFirstDiscoveryMessage);
}

function handleCellDiscoveryFeedback(ix, iy, milestoneThreshold) {
  // どの未踏セルへ入っても同じ処理・同じ価値。霧晴れを必ず最初の視覚演出にする。
  clearConfettiLayer();
  revealFogCell(ix, iy);
  logCellFogDebug("cell-discovered", {
    currentCellId: cellKey(ix, iy),
    revealStarted: true,
  });

  drawVisitedCell(ix, iy, { animate: true });
  pushLog("cell", `セル開放 (${ix},${iy})`);

  try {
    if ("vibrate" in navigator) navigator.vibrate(30);
  } catch (e) {
    // 振動非対応・失敗しても本体は継続する
  }

  const adventureSessionId =
    adventureState.status === "active" ? adventureState.sessionId : null;
  const discoveryRegistered = registerAdventureDiscovery(ix, iy);
  const sessionDiscoveryCount =
    adventureSessionId != null && discoveryRegistered
      ? adventureState.sessionDiscoveredCellIds.size
      : null;

  queueDiscoveryNotification({
    sessionId: adventureSessionId,
    sessionDiscoveryCount,
    milestoneThreshold,
  });
  if (adventureSessionId != null) {
    deferTimeGoalNotificationForDiscovery(milestoneThreshold);
  }

  logTimeGoalDebug("cell-discovered", { discoveryTriggered: true });
  // 発見と達成時刻が重なった場合、この時点で記録した優先期限を時間達成側が尊重する。
  updateAdventureTime();
}

/* ---------- 発見数の節目 ---------- */
function checkMilestones() {
  try {
    const total = Object.keys(visited).length;
    const displayed = store.get(STORAGE_KEYS.milestones, []);
    const newlyReached = MILESTONE_THRESHOLDS.filter(
      (t) => total >= t && !displayed.includes(t),
    );
    if (newlyReached.length === 0) return null;
    const toCelebrate = newlyReached[newlyReached.length - 1];
    store.set(STORAGE_KEYS.milestones, [...displayed, ...newlyReached]);
    return toCelebrate;
  } catch (e) {
    // 節目演出に失敗してもアプリ本体は継続する
    return null;
  }
}

function showMilestoneCelebration(threshold, options) {
  const msg = MILESTONE_MESSAGES[threshold] || "新しい節目に到達しました。";
  if (!options || options.showToast !== false) showToast(msg, "milestone");
  pushLog("milestone", msg);
  if (
    adventureState.status === "active" &&
    adventureState.goalReached &&
    adventureState.timeGoalNotificationPending
  ) {
    adventureState.timeGoalConfettiSuppressed = true;
  }
  try {
    spawnConfetti();
  } catch (e) {
    // 紙吹雪の失敗は無視して継続する
  }
  return msg;
}

function clearConfettiLayer() {
  const layer = el("confetti-layer");
  if (layer) layer.replaceChildren();
}

function spawnConfetti(options) {
  if (prefersReducedMotion()) return;
  const layer = el("confetti-layer");
  if (!layer) return;
  const intensity = options && options.intensity ? options.intensity : "medium";
  const durationMs =
    options && Number.isFinite(options.durationMs) ? options.durationMs : 1400;
  const colors = ["#f59e0b", "#fbbf24", "#facc15", "#e5e7eb", "#60a5fa"];
  const count = CONFETTI_PIECE_COUNTS[intensity] || CONFETTI_PIECE_COUNTS.medium;
  for (let i = 0; i < count; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 150}ms`;
    piece.style.animationDuration = `${durationMs}ms`;
    piece.style.setProperty("--drift", `${(Math.random() - 0.5) * 120}px`);
    piece.style.setProperty("--rot", `${(Math.random() - 0.5) * 720}deg`);
    layer.appendChild(piece);
    setTimeout(() => piece.remove(), durationMs + 300);
  }
}

/* ---------- 勾配スポット到達 ----------
   到達しても即座にマーカーを消さず、短い反応(拡大・発光)→通知→チェック済み状態→
   数秒後のフェードアウトという流れで達成感を返す。候補選定・標高取得は変更しない。
   （slopeQuestCompletionInProgress / pendingQuestMarkerRedraw はdrawQuestMarker付近で宣言）
   ========================================================== */

function logSlopeQuestDebug(event, extra) {
  if (!DEBUG_SLOPE_QUEST) return;
  const q = adventureState.slopeQuest;
  console.log("[slope-quest]", event, {
    questExists: q.status === "ready" || q.status === "completed",
    questLat: q.lat,
    questLng: q.lng,
    ...extra,
  });
}

// 1冒険1候補ロックの状態遷移・非同期応答の採否を追跡するための専用デバッグログ。
function logSlopeQuestLockDebug(extra) {
  if (!DEBUG_SLOPE_QUEST) return;
  const q = adventureState.slopeQuest;
  console.log("[slope-quest-lock]", {
    sessionId: adventureState.sessionId,
    status: q.status,
    requestId: q.requestId,
    questLat: q.lat,
    questLng: q.lng,
    candidateGenerationAttempted: false,
    candidateIgnoredReason: null,
    markerRedrawReason: null,
    previousMarkerLat: null,
    previousMarkerLng: null,
    newMarkerLat: null,
    newMarkerLng: null,
    ...extra,
  });
}

// 累計節目の紙吹雪が同時に出た場合は、勾配用の紙吹雪を重ねない（既存のtime-goal側と同じ判定）。
function shouldSuppressSlopeQuestConfettiForDiscovery() {
  return (
    discoveryNotificationState.phase === "milestone" ||
    discoveryNotificationState.milestoneThreshold != null
  );
}

function showSlopeQuestNotification() {
  adventureState.slopeQuestNotificationPending = false;
  const notification = el("slope-quest-notification");
  if (!notification) return false;
  const reducedMotion = prefersReducedMotion();
  const timing = {
    fadeInMs: reducedMotion
      ? SLOPE_QUEST_NOTIFICATION_TIMING.reducedFadeInMs
      : SLOPE_QUEST_NOTIFICATION_TIMING.fadeInMs,
    holdMs: SLOPE_QUEST_NOTIFICATION_TIMING.holdMs,
    fadeOutMs: reducedMotion
      ? SLOPE_QUEST_NOTIFICATION_TIMING.reducedFadeOutMs
      : SLOPE_QUEST_NOTIFICATION_TIMING.fadeOutMs,
  };
  const sessionId = adventureState.sessionId;

  notification.textContent = SLOPE_QUEST_ARRIVAL_MESSAGE;
  notification.classList.remove("hidden", "is-visible");
  notification.style.setProperty("--slope-quest-transition-ms", `${timing.fadeInMs}ms`);
  void notification.offsetWidth;
  notification.classList.add("is-visible");

  // 時間達成通知が横取りしないよう、発見系と同じ「表示中は待たせる」締め切りを延長する。
  adventureState.discoveryFeedbackUntil = Math.max(
    adventureState.discoveryFeedbackUntil,
    Date.now() +
      timing.fadeInMs +
      timing.holdMs +
      timing.fadeOutMs +
      TIME_GOAL_PRESENTATION_DELAY_MS,
  );

  scheduleAdventureFeedbackAction(sessionId, timing.fadeInMs + timing.holdMs, () => {
    notification.style.setProperty(
      "--slope-quest-transition-ms",
      `${timing.fadeOutMs}ms`,
    );
    notification.classList.remove("is-visible");
    scheduleAdventureFeedbackAction(sessionId, timing.fadeOutMs, () => {
      notification.classList.add("hidden");
    });
  });

  logSlopeQuestDebug("notification-shown", { notificationQueued: true });
  return true;
}

function applySlopeQuestCompletedState() {
  if (!questMarker) return;
  const element = questMarker.getElement();
  if (!element) return;
  element.classList.remove("is-completing");
  element.classList.add("is-completed");
  element.innerHTML = buildSlopeQuestIconHtml(true);
  element.setAttribute("aria-label", `${SLOPE_QUEST_LABEL}到達済み`);
  logSlopeQuestDebug("marker-completed", { markerCompletedStateApplied: true });
}

// 到達演出サイクルの最終ステップ。マーカーを取り除いたら、演出中に保留していた
// 新しい候補描画があればここで反映する（finishSlopeQuestCompletionCycle経由）。
function removeSlopeQuestMarker() {
  const marker = questMarker;
  if (!marker) {
    finishSlopeQuestCompletionCycle();
    return;
  }
  const element = marker.getElement();
  const finish = () => {
    if (questLayer) questLayer.removeLayer(marker);
    if (questMarker === marker) questMarker = null;
    finishSlopeQuestCompletionCycle();
  };
  if (element && !prefersReducedMotion()) {
    element.classList.add("is-removing");
    setTimeout(finish, SLOPE_QUEST_TIMING.removeFadeMs + 60);
  } else {
    finish();
  }
}

// 到達判定そのもの(同一セル一致)は既存仕様のまま。ログ用に、その判定根拠を明示的な形で残す。
function buildSlopeQuestArrivalDebugContext(curLat, curLon) {
  const { ix: curIx, iy: curIy } = cellIndex(curLat, curLon);
  const currentCellId = cellKey(curIx, curIy);
  const q = adventureState.slopeQuest;
  return {
    arrivalRule: "same-cell",
    currentCellId,
    questCellId: q.cellId,
    isSameCell: currentCellId === q.cellId,
    approximateCellSizeM: CELL_SIZE_M,
    distanceToQuestM:
      q.lat != null ? haversineMeters(curLat, curLon, q.lat, q.lng) : null,
  };
}

// 勾配スポットへの到達を検出した際の入口。handlePosition()から、既存の到達判定
// (adventureState.slopeQuest.status==='ready'かつ同一セル一致、変更しない)がtrueの時だけ呼ばれる。
function triggerSlopeQuestCompletion(curLat, curLon) {
  const completionBefore = adventureState.slopeQuestCompleted;
  if (completionBefore || slopeQuestCompletionInProgress) {
    logSlopeQuestDebug("arrival-ignored", {
      ...buildSlopeQuestArrivalDebugContext(curLat, curLon),
      completionBefore,
      completionAfter: adventureState.slopeQuestCompleted,
      completionEffectTriggered: false,
    });
    return;
  }
  slopeQuestCompletionInProgress = true;
  adventureState.slopeQuestCompleted = true;
  adventureState.slopeQuest.status = "completed"; // 到達後は新しい候補生成を開始しない(ensureQuestの入口ガードで担保)

  const score = adventureState.slopeQuest.score;
  const gradientLabel = score != null ? `勾配目安${score}%` : "";
  pushLog("quest", `${SLOPE_QUEST_LABEL}に到達 ${gradientLabel}`.trim());

  try {
    if ("vibrate" in navigator) navigator.vibrate(35);
  } catch (e) {
    // 振動非対応・失敗（iPhone Safari等）でも到達自体は伝わるようにする
  }

  const reducedMotion = prefersReducedMotion();
  const element = questMarker ? questMarker.getElement() : null;
  if (element && !reducedMotion) {
    element.classList.add("is-completing"); // 一度だけの拡大・リング発光（CSS側、約450ms）
  }

  const confettiSuppressed = shouldSuppressSlopeQuestConfettiForDiscovery();
  let confettiTriggered = false;
  if (!confettiSuppressed) {
    try {
      spawnConfetti(SLOPE_QUEST_CONFETTI);
      confettiTriggered = true;
    } catch (e) {
      // 紙吹雪の失敗は無視して継続する
    }
  }

  // 優先順位: 霧晴れ＞発見通知＞累計節目＞勾配スポット到達＞時間達成。
  // 発見通知が進行中なら、その終了時(finishDiscoveryNotification)に回す。
  const notificationQueued = true;
  if (isDiscoveryNotificationActive()) {
    adventureState.slopeQuestNotificationPending = true;
  } else {
    showSlopeQuestNotification();
  }

  const checkStateDelay = reducedMotion
    ? SLOPE_QUEST_TIMING.reducedCheckStateDelayMs
    : SLOPE_QUEST_TIMING.checkStateDelayMs;
  const checkTimer = setTimeout(() => {
    applySlopeQuestCompletedState();
    const removeTimer = setTimeout(() => {
      removeSlopeQuestMarker();
    }, SLOPE_QUEST_TIMING.holdCompletedMs);
    slopeQuestMarkerTimers.push(removeTimer);
  }, checkStateDelay);
  slopeQuestMarkerTimers.push(checkTimer);

  logSlopeQuestDebug("completed", {
    ...buildSlopeQuestArrivalDebugContext(curLat, curLon),
    completionBefore,
    completionAfter: adventureState.slopeQuestCompleted,
    completionEffectTriggered: true,
    confettiTriggered,
    notificationQueued,
  });

  // slopeQuestCompletionInProgressはここではfalseに戻さない。到達演出サイクル全体
  // (チェック済み化→保持→フェードアウト削除)が終わるまで維持し、
  // finishSlopeQuestCompletionCycle()(removeSlopeQuestMarker経由)で解除する。
}

/* ---------- 今日歩いた形（ルート形状） ----------
   冒険中に記録したGPS軌跡(adventureState.routePoints)を、地図タイル・地名・現在地を
   一切使わずに抽象的な線として描く。実際の緯度経度は表示せず、形だけを残す。
   ========================================================== */

// 緯度経度を、原点(origin)からの相対メートル座標へ変換する（既存のtoMeters()を再利用）。
// 実際の地図位置とは無関係な「形」だけを残すため、画面はy(北)を上にして反転する。
function projectRoutePoints(points) {
  return points.map((p) => {
    const m = toMeters(p.lat, p.lon);
    return { x: m.x, y: -m.y };
  });
}

// 共有カードなど将来の再利用向けに、回転・左右反転だけを分離した純粋関数にしておく。
// 通常の終了画面ではrotationSteps=0, flipX=false（実際の向きのまま）で呼ぶ。
function rotateRoutePoints(points, rotationSteps, flipX) {
  let result = points;
  const steps = ((rotationSteps % 4) + 4) % 4;
  for (let i = 0; i < steps; i++) {
    result = result.map((p) => ({ x: -p.y, y: p.x })); // 時計回りに90度
  }
  if (flipX) {
    result = result.map((p) => ({ x: -p.x, y: p.y }));
  }
  return result;
}

// ルート全体をviewBox内へアスペクト比を保ったまま収める。幅・高さがほぼ0(直線・ほぼ同一点)
// でもゼロ除算しないよう、スパンが実質0の軸は拡大率の計算から除外する。
function fitRoutePointsToViewBox(points, viewBox) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const availableW = viewBox.width - viewBox.padding * 2;
  const availableH = viewBox.height - viewBox.padding * 2;

  const scaleCandidates = [];
  if (spanX > ROUTE_SHAPE_MIN_SPAN_M) scaleCandidates.push(availableW / spanX);
  if (spanY > ROUTE_SHAPE_MIN_SPAN_M) scaleCandidates.push(availableH / spanY);
  const scale = scaleCandidates.length > 0 ? Math.min(...scaleCandidates) : 1;

  const scaledW = spanX * scale;
  const scaledH = spanY * scale;
  const offsetX = viewBox.padding + (availableW - scaledW) / 2;
  const offsetY = viewBox.padding + (availableH - scaledH) / 2;

  return {
    points: points.map((p) => ({
      x: offsetX + (p.x - minX) * scale,
      y: offsetY + (p.y - minY) * scale,
    })),
    scale,
    bounds: { minX, maxX, minY, maxY, spanX, spanY },
  };
}

function buildRoutePathData(points) {
  if (!points || points.length < 2) return "";
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
}

// 記録済みのルート点から、そのまま描画できる状態まで組み立てる。
// 有効点が2未満の場合は、呼び出し側でルート枠自体を非表示にする。
function getRouteShapeRenderData(options) {
  const renderOptions = options || {};
  const rotationSteps = Number.isFinite(renderOptions.rotationSteps)
    ? Math.trunc(renderOptions.rotationSteps)
    : 0;
  const flipX = renderOptions.flipX === true;
  const rawCount = adventureState.routePoints.length;
  const validPoints = adventureState.routePoints.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon),
  );
  if (validPoints.length < 2) {
    return {
      visible: false,
      pathData: "",
      rawPointCount: rawCount,
      validPointCount: validPoints.length,
      bounds: null,
      scale: null,
      rotationSteps,
      flipX,
    };
  }

  const relativePoints = projectRoutePoints(validPoints);
  const orientedPoints = rotateRoutePoints(
    relativePoints,
    rotationSteps,
    flipX,
  );
  const fitted = fitRoutePointsToViewBox(orientedPoints, ROUTE_SHAPE_VIEWBOX);
  return {
    visible: true,
    pathData: buildRoutePathData(fitted.points),
    rawPointCount: rawCount,
    validPointCount: validPoints.length,
    bounds: fitted.bounds,
    scale: fitted.scale,
    rotationSteps,
    flipX,
  };
}

function logRouteShapeDebug(renderData, renderedPathLength, context) {
  if (!DEBUG_ROUTE_SHAPE) return;
  const reviewContext = context || {};
  const lastPoint = adventureState.lastRoutePoint;
  console.log("[route-shape-review]", {
    screenType: reviewContext.screenType || "completion-sheet",
    selectedCardType: reviewContext.selectedCardType || null,
    rawRoutePointCount: renderData.rawPointCount,
    validRoutePointCount: renderData.validPointCount,
    simplifiedRoutePointCount: renderData.validPointCount, // 現状は記録間隔による間引きのみ
    sessionVisitedCellCount: adventureState.sessionVisitedCellIds.size,
    sessionDiscoveredCellCount: adventureState.sessionDiscoveredCellIds.size,
    routePathD: renderData.pathData,
    routeSvgExists: Boolean(
      document.getElementById(reviewContext.svgId || "adventure-route-shape"),
    ),
    routePathExists: Boolean(
      document.getElementById(reviewContext.pathId || "adventure-route-path"),
    ),
    oldCellShapeContainerExists: Boolean(
      document.querySelector(
        ".cell-shape, .share-cell-grid, .route-grid, .achievement-shape-grid",
      ),
    ),
    routeRendererCalled: true,
    cellShapeRendererCalled: false,
    routeDistanceM: lastPoint ? lastPoint.cumulativeDistanceM : 0,
    bounds: renderData.bounds,
    scale: renderData.scale,
    rotationSteps: renderData.rotationSteps,
    flipX: renderData.flipX,
    renderedPathLength,
    routeSvgVisible: renderData.visible,
  });
}

// 終了画面と成果カードで同じGPSルート描画を使う。成果カードでは向きを匿名化し、
// 即時描画することで、カードを開いた直後のスクリーンショットでも線が欠けないようにする。
function renderRouteShape(options) {
  const renderOptions = options || {};
  const sectionId = renderOptions.sectionId || "adventure-route-summary";
  const svgId = renderOptions.svgId || "adventure-route-shape";
  const pathId = renderOptions.pathId || "adventure-route-path";
  const section = el(sectionId);
  const svg = el(svgId);
  const path = el(pathId);
  if (!section || !svg || !path) return null;

  const renderData = getRouteShapeRenderData({
    rotationSteps: renderOptions.rotationSteps,
    flipX: renderOptions.flipX,
  });
  const debugContext = {
    screenType: renderOptions.screenType || "completion-sheet",
    selectedCardType: renderOptions.selectedCardType || null,
    svgId,
    pathId,
  };
  section.classList.toggle("hidden", !renderData.visible);

  if (!renderData.visible) {
    path.removeAttribute("d");
    path.style.transition = "none";
    path.style.strokeDasharray = "";
    path.style.strokeDashoffset = "";
    logRouteShapeDebug(renderData, 0, debugContext);
    return renderData;
  }

  // 多重アニメーション防止: 前回分のtransitionを一旦切ってから新しい形状・状態を設定する。
  path.style.transition = "none";
  path.setAttribute("d", renderData.pathData);

  const length =
    typeof path.getTotalLength === "function" ? path.getTotalLength() : 0;
  const reducedMotion = prefersReducedMotion();
  const animate = renderOptions.animate !== false;

  if (!animate || reducedMotion || !(length > 0)) {
    path.style.strokeDasharray = "";
    path.style.strokeDashoffset = "0";
  } else {
    path.style.strokeDasharray = `${length}`;
    path.style.strokeDashoffset = `${length}`;
    requestAnimationFrame(() => {
      path.style.transition = `stroke-dashoffset ${ROUTE_SHAPE_DRAW_DURATION_MS}ms ease-out`;
      path.style.strokeDashoffset = "0";
    });
  }

  logRouteShapeDebug(renderData, length, debugContext);
  return renderData;
}

// 共有カードでは北向きや左右関係を手掛かりにしにくくするため、セッションごとに
// 90度単位の回転と左右反転を固定する。開き直してもカードの形は変わらない。
function getAchievementRouteOrientation() {
  const sessionSeed = Number.isFinite(adventureState.sessionId)
    ? Math.abs(Math.trunc(adventureState.sessionId))
    : 0;
  return {
    rotationSteps: sessionSeed % 2 === 0 ? 1 : 3,
    flipX: Math.floor(sessionSeed / 2) % 2 === 1,
  };
}

/* ---------- 冒険完了シート ---------- */
let lastCompletionMessage = ""; // 成果カードでも同じ一行メッセージを使い回すため保持

function getAdventureCompletionData() {
  const preset = adventureState.preset
    ? ADVENTURE_PRESETS[adventureState.preset]
    : null;
  return {
    actualDurationMs: adventureState.elapsedAdventureMs,
    distanceMeters: adventureState.distanceMeters,
    visitedCellCount: adventureState.sessionVisitedCellIds.size,
    discoveredCellCount: adventureState.sessionDiscoveredCellIds.size,
    startedAt: adventureState.startedAt,
    endedAt: adventureState.endedAt,
    selectedPresetMinutes: preset ? preset.minutes : null,
    goalReached: adventureState.goalReached,
    slopeQuestCompleted: adventureState.slopeQuestCompleted,
    direction: adventureState.direction ? { ...adventureState.direction } : null,
  };
}

function getAdventureEndMessage(discoveredCellCount) {
  return discoveredCellCount > 0
    ? ADVENTURE_END_MESSAGES.withDiscovery
    : ADVENTURE_END_MESSAGES.noDiscovery;
}

function showCompletionSheet(completionData) {
  const data = completionData || getAdventureCompletionData();
  el("completion-title").textContent = "今日の冒険、おつかれさま！";
  try {
    renderRouteShape();
  } catch (e) {
    // ルート形状の描画に失敗しても、終了画面本体(数値・メッセージ)は表示を継続する。
    console.error("renderRouteShape failed", e);
  }
  el("completion-elapsed").textContent = formatAdventureMinutes(
    data.actualDurationMs,
  );
  el("completion-distance").textContent = formatAdventureDistance(
    data.distanceMeters,
  );
  el("completion-discovered-cells").textContent = `${data.discoveredCellCount}`;
  const badge = el("slope-quest-result-badge");
  if (badge) badge.hidden = !data.slopeQuestCompleted;
  logSlopeQuestDebug("completion-sheet-rendered", {
    resultBadgeShown: !!data.slopeQuestCompleted,
  });
  lastCompletionMessage = getAdventureEndMessage(data.discoveredCellCount);
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
  "map-direction-panel",
  "completion-sheet",
];
let shareCardReturnFocusEl = null;

function getFocusableElements(container) {
  const nodes = container.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  return Array.from(nodes).filter(
    (n) => !n.disabled && n.offsetParent !== null,
  );
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
  } else if (
    e.key === "Escape" &&
    (container.id === "direction-card" || container.id === "achievement-card")
  ) {
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
  if (
    shareCardReturnFocusEl &&
    typeof shareCardReturnFocusEl.focus === "function"
  ) {
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
  el("share-sign-board").style.transform =
    `rotate(${adventureState.direction.bearingDeg}deg)`;
  el("direction-card-text").textContent =
    `今日は${adventureState.direction.label}へ。`;
  openShareCard("direction-card");
}

/* ---------- Priority 2 + 4: 冒険成果カード ---------- */
function showAchievementCard() {
  el("achievement-cell-count").textContent =
    `${adventureState.sessionDiscoveredCellIds.size}`;
  const preset = adventureState.preset
    ? ADVENTURE_PRESETS[adventureState.preset]
    : null;
  el("achievement-duration").textContent = preset
    ? `${preset.minutes}分`
    : "--";
  el("achievement-direction").textContent = adventureState.direction
    ? adventureState.direction.label
    : "--";
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
    const orientation = getAchievementRouteOrientation();
    renderRouteShape({
      sectionId: "achievement-route-summary",
      svgId: "achievement-route-shape",
      pathId: "achievement-route-path",
      screenType: "achievement-card",
      selectedCardType: "achievement-card",
      rotationSteps: orientation.rotationSteps,
      flipX: orientation.flipX,
      animate: false,
    });
  } catch (e) {
    // GPSルート描画に失敗してもカード本体は表示し、セル形状へは戻さない。
    console.error("renderAchievementRouteShape failed", e);
    const routeSummary = el("achievement-route-summary");
    if (routeSummary) routeSummary.classList.add("hidden");
  }

  openShareCard("achievement-card");
}

/* ---------- 位置情報の処理 ---------- */
let lastAccuracyWarnAt = 0;
let lastReliablePosition = null;
let lastReliableCellId = null;

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
    const positionTimestamp = Number.isFinite(pos.timestamp)
      ? pos.timestamp
      : Date.now();
    lastReliablePosition = { lat, lon, timestamp: positionTimestamp };
    lastReliableCellId = key;
    adventureState.currentCellId = key;

    if (adventureState.status === "active") {
      registerAdventureDistance(lat, lon, positionTimestamp, accuracy);
      registerAdventureVisitedCell(ix, iy);
      recordRoutePoint(lat, lon, positionTimestamp, accuracy);
    }

    if (!visited[key]) {
      visited[key] = { ts: Date.now(), lat, lon };
      store.set(STORAGE_KEYS.visited, visited);
      // 節目は先に記録だけ確定し、見た目はhandleCellDiscoveryFeedback内で
      // 霧晴れ→通常発見→節目→コース達成の順に遅延表示する。
      const milestoneThreshold = checkMilestones();
      handleCellDiscoveryFeedback(ix, iy, milestoneThreshold);
    }

    if (
      adventureState.slopeQuest.status === "ready" &&
      adventureState.slopeQuest.cellId === key
    ) {
      // 到達判定(同一セル一致)は変更しない。マーカーの見た目(チェック済み化→
      // 数秒後のフェードアウト)はtriggerSlopeQuestCompletion側のタイマーに委ねるため、
      // ここではquestLayerを即座にクリアしない。
      triggerSlopeQuestCompletion(lat, lon);
    }

    updateFogCells(lat, lon); // 精度の粗い測位では霧の中心もずらさない（GPSノイズでの誤表示を避ける）
  }

  updateAdventureTime();

  updateHud(lat, lon);
  updateFrontierCompassFlow(lat, lon, reliable);
  ensureQuest();
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
      navigator.geolocation.getCurrentPosition(
        handlePosition,
        handlePositionError,
        {
          enableHighAccuracy: false,
          timeout: 20000,
          maximumAge: 60000,
        },
      );
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
  errorEl.textContent =
    messages[err.code] ||
    "現在地を取得できませんでした。もう一度お試しください。";
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
  navigator.geolocation.getCurrentPosition(
    handlePosition,
    handlePositionError,
    {
      enableHighAccuracy: true,
      timeout: 15000,
    },
  );
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
  el("btn-log").addEventListener("click", () =>
    el("log-panel").classList.remove("hidden"),
  );
  el("btn-close-log").addEventListener("click", () =>
    el("log-panel").classList.add("hidden"),
  );
  el("btn-close-quest").addEventListener("click", () =>
    el("quest-panel").classList.add("hidden"),
  );

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
    btn.addEventListener("click", () =>
      selectAdventurePreset(btn.dataset.preset),
    );
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

  // ---- 地図を見て方向を選ぶ補助モード ----
  el("btn-open-map-direction").addEventListener("click", openMapDirectionMode);
  el("btn-map-direction-back").addEventListener("click", cancelMapDirectionMode);
  el("btn-map-direction-confirm").addEventListener("click", confirmMapDirection);
  el("btn-map-direction-recenter").addEventListener("click", recenterMapDirection);

  // ---- 夜間セーフティ ----
  el("btn-night-cancel").addEventListener("click", () => {
    hideNightWarning();
    setAdventureStatus("idle");
  });
  el("btn-night-continue").addEventListener("click", () => {
    adventureState.nightSafetyAcknowledged = true;
    hideNightWarning();
    showDurationPanel();
  });

  // ---- 冒険開始・終了 ----
  el("btn-begin-adventure").addEventListener("click", beginAdventureFlow);
  el("btn-end-adventure").addEventListener("click", endAdventure);
  document.addEventListener("visibilitychange", handleAdventureVisibilityChange);

  // ---- 冒険完了シート ----
  el("btn-open-way-home").addEventListener("click", openWayHome);
  el("btn-continue-adventure").addEventListener("click", continueAdventure);
  el("btn-finish-today").addEventListener("click", finishToday);

  // ---- 共有カード ----
  el("btn-show-direction-card").addEventListener("click", showDirectionCard);
  el("btn-close-direction-card").addEventListener("click", () =>
    closeShareCard("direction-card"),
  );
  el("btn-show-achievement-card").addEventListener(
    "click",
    showAchievementCard,
  );
  el("btn-close-achievement-card").addEventListener("click", () =>
    closeShareCard("achievement-card"),
  );
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
