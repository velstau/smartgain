/**
 * SmartGain - Options Page Script
 * 
 * 設定画面 (options.html) のUI制御を行います。
 * Chrome Storage への保存・読み込みと、UI要素への反映を担当します。
 */

// デフォルト設定
const defaultSettings = {
  featureEnabled: true,
  enabledSites: {
    youtube: true,
    twitch: true
  },
  customSites: "",
  scrollControlEnabled: true,
  osdEnabled: true,
  osdPosition: 'top-right',
  defaultVolume: 50,
  stepSize: 5,
  autoGainEnabled: false,
  autoGainTargetLufs: -16,
  autoGainMaxBoost: 12,
  autoGainCompression: 'light',
  autoGainSpeed: 'normal',
  showDebugInfo: false,
  visualizerEnabled: false,
  visualizerType: 'overlay'
};

// DOM要素のキャッシュ (DOMContentLoaded後に取得する前提だが、
// ここでは呼び出し時に参照されるゲッターにするか、あるいは初期化後に代入する形が安全。
// しかし単純化のため、DOMContentLoadedイベント内でこれらを使う形であれば
// グローバルスコープで宣言だけしておき、初期化関数内で取得するのがベスト。
// 今回は元のコードの意図を汲み、遅延取得されるように getter を使うか、初期化関数内で取得する形へ修正します)

let elements = {};

/**
 * ステータスメッセージを表示する
 * @param {string} msg 表示するメッセージ
 * @param {string} type 'success' | 'error'
 */
const showStatus = (msg, type = 'success') => {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;

  statusEl.textContent = msg;
  statusEl.style.opacity = '1';
  statusEl.style.color = type === 'success' ? '#4CAF50' : '#f44336';
  setTimeout(() => {
    statusEl.style.opacity = '0';
  }, 2000);
};

/**
 * UIの表示状態を更新する (依存関係の解決)
 * 例: Visualizerが無効なら、Visualizer Typeの選択肢も無効化するなど
 */
const updateUiState = () => {
  if (!elements.visualizerEnabled) return; // まだ初期化されていない

  // 現在は単純な実装のみ
  elements.visualizerType.disabled = !elements.visualizerEnabled.checked;
  elements.osdPosition.disabled = !elements.osdEnabled.checked;
};

/**
 * 設定を保存する
 * フォームの値を取得し、chrome.storage.syncに保存します。
 */
const saveOptions = () => {
  const options = {
    featureEnabled: elements.featureEnabled.checked,
    enabledSites: {
      youtube: elements.enableYoutube.checked,
      twitch: elements.enableTwitch.checked
    },
    customSites: elements.customSites.value,
    scrollControlEnabled: elements.scrollControlEnabled.checked,
    osdEnabled: elements.osdEnabled.checked,
    osdPosition: elements.osdPosition.value,
    defaultVolume: Number(elements.defaultVolume.value),
    stepSize: Number(elements.stepSize.value),

    autoGainEnabled: elements.autoGainEnabled.checked,
    autoGainTargetLufs: Number(elements.autoGainTargetLufs.value),
    autoGainMaxBoost: Number(elements.autoGainMaxBoost.value),
    autoGainCompression: elements.autoGainCompression.value,
    autoGainSpeed: elements.autoGainSpeed.value,

    showDebugInfo: elements.showDebugInfo.checked,

    visualizerEnabled: elements.visualizerEnabled.checked,
    visualizerType: elements.visualizerType.value
  };

  chrome.storage.sync.set(options, () => {
    showStatus('設定を保存しました');
  });
};

/**
 * 設定を読み込んでUIに反映する
 */
const restoreOptions = () => {
  // DOM要素を取得してキャッシュ
  elements = {
    featureEnabled: document.getElementById('featureEnabled'),

    // Site Toggles
    enableYoutube: document.getElementById('enableYoutube'),
    enableTwitch: document.getElementById('enableTwitch'),
    customSites: document.getElementById('customSites'),

    scrollControlEnabled: document.getElementById('scrollControlEnabled'),
    osdEnabled: document.getElementById('osdEnabled'),
    osdPosition: document.getElementById('osdPosition'),
    defaultVolume: document.getElementById('defaultVolume'),
    stepSize: document.getElementById('stepSize'),

    // Auto-Gain 設定
    autoGainEnabled: document.getElementById('autoGainEnabled'),
    autoGainTargetLufs: document.getElementById('autoGainTargetLufs'),
    autoGainMaxBoost: document.getElementById('autoGainMaxBoost'),
    autoGainCompression: document.getElementById('autoGainCompression'),
    autoGainSpeed: document.getElementById('autoGainSpeed'),

    // Debug
    showDebugInfo: document.getElementById('showDebugInfo'),

    // Visualizer 設定
    visualizerEnabled: document.getElementById('visualizerEnabled'),
    visualizerType: document.getElementById('visualizerType'),

    status: document.getElementById('status')
  };

  chrome.storage.sync.get(defaultSettings, (items) => {
    // 取得した設定値を各要素に適用
    elements.featureEnabled.checked = items.featureEnabled;

    if (items.enabledSites) {
      elements.enableYoutube.checked = items.enabledSites.youtube;
      elements.enableTwitch.checked = items.enabledSites.twitch;
    } else {
      // 後方互換性: 設定がない場合はすべてON
      elements.enableYoutube.checked = true;
      elements.enableTwitch.checked = true;
    }

    elements.customSites.value = items.customSites || "";

    elements.scrollControlEnabled.checked = items.scrollControlEnabled;
    elements.osdEnabled.checked = items.osdEnabled;
    elements.osdPosition.value = items.osdPosition;
    elements.defaultVolume.value = items.defaultVolume;
    elements.stepSize.value = items.stepSize;

    elements.autoGainEnabled.checked = items.autoGainEnabled;
    elements.autoGainTargetLufs.value = items.autoGainTargetLufs;
    elements.autoGainMaxBoost.value = items.autoGainMaxBoost;
    elements.autoGainCompression.value = items.autoGainCompression;
    elements.autoGainSpeed.value = items.autoGainSpeed;

    elements.showDebugInfo.checked = items.showDebugInfo;

    elements.visualizerEnabled.checked = items.visualizerEnabled;
    elements.visualizerType.value = items.visualizerType;

    // Visualizerタイプなどの依存関係のあるUIを更新
    updateUiState();

    // 各要素の変更を監視して自動保存するためのリスナーを登録
    // (一度呼べばいいのでここで登録)
    setupListeners();
  });
};

/**
 * イベントリスナー登録
 */
const setupListeners = () => {
  const watchElements = [
    elements.featureEnabled,
    elements.enableYoutube,
    elements.enableTwitch,
    elements.customSites,
    elements.scrollControlEnabled,
    elements.osdEnabled,
    elements.osdPosition,
    elements.defaultVolume,
    elements.stepSize,
    elements.autoGainEnabled,
    elements.autoGainTargetLufs,
    elements.autoGainMaxBoost,
    elements.autoGainCompression,
    elements.autoGainSpeed,
    elements.showDebugInfo,
    elements.visualizerEnabled,
    elements.visualizerType
  ];

  watchElements.forEach(el => {
    if (el) {
      el.addEventListener('change', () => {
        updateUiState();
        saveOptions();
      });
    }
  });
};

/**
 * デバッグログ (content.js が chrome.storage.local に "dbg:<id>" で保存した動画ごとの集計)
 */
const fmt = (v, signed = false) => {
  if (v === null || v === undefined) return '-';
  return (signed && v > 0 ? '+' : '') + v.toFixed(1);
};

const formatDebugLog = (sessions) => {
  const manifest = chrome.runtime.getManifest();
  const lines = [
    `SmartGain デバッグログ (拡張 v${manifest.version}, ${new Date().toLocaleString('ja-JP')} 出力)`,
    '項目: 開始 | 動画 | 版/mode | 設定(目標/圧縮/速度/最大ブースト) | 計測秒 | 手動音量% | 入力L | 平均G | 平均C | 平均GR | 出力L | 出力p10〜p90',
    '※ 出力L は手動音量 100% 換算。動画間で出力L が揃っていれば正規化は機能している'
  ];
  for (const s of sessions) {
    const start = new Date(s.startedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const video = `${s.title || '(不明)'}${s.videoId ? ` [${s.videoId}]` : (s.url ? ` <${s.url}>` : '')}`;
    const st = s.settings || {};
    lines.push([
      start,
      video,
      `v${s.version}/${s.mode}`,
      `${st.target}/${st.compression}/${st.speed}/${st.maxBoost}`,
      `${s.seconds}s`,
      fmt(s.userVol),
      fmt(s.inL),
      fmt(s.gain, true),
      fmt(s.comp, true),
      fmt(s.gr),
      fmt(s.outL),
      `${fmt(s.outP10)}〜${fmt(s.outP90)}`
    ].join(' | '));
  }
  return lines.join('\n');
};

const loadDebugSessions = (callback) => {
  chrome.storage.local.get(null, (items) => {
    const sessions = Object.keys(items)
      .filter((k) => k.startsWith('dbg:'))
      .map((k) => items[k])
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    callback(sessions);
  });
};

const renderDebugLog = () => {
  const el = document.getElementById('debugLog');
  if (!el) return;
  loadDebugSessions((sessions) => {
    el.textContent = sessions.length ? formatDebugLog(sessions) : '（記録なし）';
  });
};

const setupDebugLog = () => {
  renderDebugLog();
  document.getElementById('copyDebugLog').addEventListener('click', () => {
    loadDebugSessions((sessions) => {
      navigator.clipboard.writeText(formatDebugLog(sessions))
        .then(() => showStatus(`${sessions.length} 件のログをコピーしました`))
        .catch(() => showStatus('コピーに失敗しました', 'error'));
    });
  });
  document.getElementById('clearDebugLog').addEventListener('click', () => {
    chrome.storage.local.get(null, (items) => {
      chrome.storage.local.remove(Object.keys(items).filter((k) => k.startsWith('dbg:')), () => {
        renderDebugLog();
        showStatus('ログをクリアしました');
      });
    });
  });
  // 再生中のタブからの更新を反映
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('dbg:'))) renderDebugLog();
  });
};

// 初期化実行
document.addEventListener('DOMContentLoaded', restoreOptions);
document.addEventListener('DOMContentLoaded', setupDebugLog);
