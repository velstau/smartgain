// Utility: エラー抑制ラッパー
// Chrome拡張機能のコンテキストが無効化された場合などのエラーを吸収します
const safeExecute = (callback) => {
    try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
            callback();
        }
    } catch (e) { /* ignore context invalidated */ }
};

// 非同期通信用コールバックの安全なラッパー
const safeCallback = (callback) => {
    return (...args) => {
        try {
            if (chrome.runtime.lastError) return;
            callback(...args);
        } catch (e) { }
    };
};

// ヘルパー: パーセント変換 (小数第1位まで)
const toPercent = (vol) => parseFloat((vol * 100).toFixed(1));

class VolumeController {
    constructor() {
        // メインの動画要素を見つけるためのセレクタ。HTML5標準のvideoタグをターゲットにします。
        this.videoSelector = 'video.html5-main-video'; // YouTube
        this.videoFallbackSelector = 'video'; // Generic / Twitch / etc

        // 状態管理用フラグ
        this.isRightClickDown = false; // 右クリックが押されているか
        this.hasScrolled = false;      // 右クリック中にスクロール操作が行われたか
        this.intendedVolume = null;    // 拡張機能が設定しようとしている「意図した」ボリューム値 (0-100)
        this.lastVideoId = null;       // 動画変更検知用ID
        this.lastUserActionTime = 0;   // ユーザー操作時刻（競合回避用）
        this.currentReportedVolume = undefined; // inject.jsから報告された正確なボリューム値 (Stable Volume対策)
        this.settingsLoaded = false; // 設定読み込み完了フラグ
        this.initTimestamp = Date.now(); // ページ読み込み時刻（初期ボリューム固定用）

        // デフォルト設定
        this.settings = {
            featureEnabled: true,
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
            visualizerType: 'overlay',
            enabledSites: { youtube: true, twitch: true },
            customSites: ""
        };

        this.init();
    }

    /**
     * 現在のサイトで機能が有効かどうか判定する
     */
    isSiteEnabled() {
        const hostname = window.location.hostname;
        const sites = this.settings.enabledSites || { youtube: true, twitch: true };

        if (hostname.includes('youtube.com')) {
            return sites.youtube;
        } else if (hostname.includes('twitch.tv')) {
            return sites.twitch;
        } else {
            // カスタムサイトリストのチェック
            const customList = (this.settings.customSites || "").split('\n');
            for (let site of customList) {
                site = site.trim();
                if (site && hostname.includes(site)) {
                    return true;
                }
            }
            return false;
        }
    }

    // 動画要素を取得するヘルパーメソッド
    getVideoElement() {
        return document.querySelector(this.videoSelector) || document.querySelector(this.videoFallbackSelector);
    }

    init() {
        // 設定読み込み & 初期動作
        safeExecute(() => {
            chrome.storage.sync.get(this.settings, safeCallback((items) => {
                this.settings = items;
                this.settingsLoaded = true;

                // サイト別有効確認
                if (this.isSiteEnabled()) {
                    console.log('[SmartGain] Site is enabled. Starting extension...');
                    this.startExtension();

                    // 設定読み込み完了後に適用試行（設定値に基づいて初期化）
                    this.attemptApplySettings();
                    this.syncSettingsToInject();
                    // 既にボリューム報告などが来ている場合、デバッグ表示設定を即座に反映
                    // Reportイベントが未到着でも、Debug情報があれば表示を開始する
                    const vol = this.currentReportedVolume !== undefined
                        ? this.currentReportedVolume
                        : (this.intendedVolume || Number(this.settings.defaultVolume));

                    if (this.currentReportedVolume !== undefined || (this.settings.osdEnabled && this.settings.showDebugInfo)) {
                        this.updateVolumeDisplay(vol);
                    }
                } else {
                    console.log('[SmartGain] Disabled on this site by settings.');
                    this.settings.featureEnabled = false; // 内部的にOFFにする
                }
            }));
        });

        // Chromeのストレージ変更イベントを監視し、設定が動的に変わった場合に反映させます
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'sync') {
                for (let key in changes) {
                    // 設定調整中（ユーザーがホイール操作中）の場合、
                    // 自分が保存した値の「跳ね返り」でローカル変数が上書きされるのを防ぐ
                    // ただし、featureEnabledなどはホイール操作対象外なので除外してもいいが、
                    // isAdjustingSettingsはホイール操作時のみtrueになるため、これで十分ガードできる
                    if (this.isAdjustingSettings) {
                        // もしユーザー操作中なら、ストレージからの更新を無視する (ローカルが正)
                        continue;
                    }

                    // hasOwnPropertyチェックを削除: 新しい設定項目の場合も受け入れる
                    this.settings[key] = changes[key].newValue;
                }

                // サイトが無効な場合は何もしない
                // (動的に有効化された場合のハンドリングは複雑になるため、リロードを促すか、
                //  あるいはここで check → startExtension する手もあるが、まずは無関係なサイトでの動作防止を優先)
                if (!this.isSiteEnabled()) return;

                // 特定の設定変更時は再適用処理を走らせる
                if (!this.isAdjustingSettings && (changes.featureEnabled || changes.defaultVolume)) {
                    this.attemptApplySettings();
                }
                // 設定変更を即座に通知
                if (!this.isAdjustingSettings) {
                    this.syncSettingsToInject();
                }
            }
        });
    }

    /**
     * 拡張機能のメイン処理を開始する
     * (設定読み込み & サイト有効判定後に呼ばれる)
     */
    startExtension() {
        // イベントリスナー登録 (injectからのメッセージ受信など)
        this.setupEventListeners();

        // ページスクリプト注入
        this.injectScript();
    }

    /**
     * 設定保存のデバウンス処理
     * 連続したスクロール操作による大量の書き込みを防ぐ
     */
    debouncedSave(key, value) {
        if (!this.saveTimers) this.saveTimers = {};

        if (this.saveTimers[key]) clearTimeout(this.saveTimers[key]);

        this.saveTimers[key] = setTimeout(() => {
            try {
                let data = {};
                data[key] = value;
                if (chrome.runtime && chrome.runtime.id) {
                    chrome.storage.sync.set(data);
                }
            } catch (e) {
                // Extension context invalidated, ignore
            }
            this.saveTimers[key] = null;
        }, 500); // 500ms待ってから保存
    }

    /**
     * inject.js (ページコンテキストで動くスクリプト) をDOMに注入します。
     * これにより、YouTubeのプレーヤーオブジェクト(movie_player)やWeb Audio APIに
     * 直接アクセスできるようになります。
     */
    injectScript() {
        if (this.injected) return;

        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('inject.js');
        script.onload = () => {
            this.injected = true;
            // 注入直後に初期設定を送信
            this.syncSettingsToInject();
        };
        (document.head || document.documentElement).appendChild(script);
    }

    /**
     * inject.js に現在の設定値を送信します。
     * CustomEventを使用して、Content Script -> Page Script への通信を行います。
     */
    syncSettingsToInject() {
        window.dispatchEvent(new CustomEvent('YoutubeVolumeControlSettings', {
            detail: this.settings
        }));
    }

    /**
     * ページ内の動画要素を取得します。
     * YouTubeの仕様変更に対応するため、複数のセレクタを試します。
     */
    getVideoElement() {
        // YouTube
        let video = document.querySelector('video.html5-main-video');
        if (video) return video;

        // Twitch / General
        // 複数のvideoがある場合、再生中やサイズが大きいものを優先したいが、
        // とりあえず最初に見つかったものを返す（通常のシングル動画サイトならこれで動く）
        const videos = document.querySelectorAll('video');
        if (videos.length > 0) {
            // 再生中のものを優先検索
            for (let v of videos) {
                if (!v.paused && v.readyState > 0) return v;
            }
            // なければ最初のもの
            return videos[0];
        }
        return null;
    }

    /**
     * DOMイベントリスナーの設定
     */
    setupEventListeners() {
        // inject.js からの音量報告を受信
        window.addEventListener('YoutubeVolumeControlReport', (e) => {
            // 設定変更中（ターゲットやデフォルト音量の調整中）は、
            // 報告された現在音量でOSDを上書きしないようにする
            if (this.isAdjustingSettings) return;

            const vol = e.detail;
            if (typeof vol === 'number') {
                this.currentReportedVolume = vol;
                // OSD表示をこの正確な値で更新
                this.updateVolumeDisplay(vol);

                // AutoGain有効時や初期状態では、報告された値を「意図した音量」として同期
                if (this.intendedVolume === null || this.settings.autoGainEnabled) {
                    this.intendedVolume = vol;
                }
            }
        });

        // Inject側からの動画ごとの集計 (デバッグログ) を保存
        // 複数タブからの同時書き込みで競合しないよう、セッションごとに別キーにする
        window.addEventListener('YoutubeVolumeControlStats', (e) => {
            const stats = e.detail;
            if (!stats || !stats.id) return;
            safeExecute(() => {
                const key = `dbg:${stats.id}`;
                chrome.storage.local.set({ [key]: stats });
                if (!this.savedStatsIds) this.savedStatsIds = new Set();
                if (!this.savedStatsIds.has(stats.id)) {
                    this.savedStatsIds.add(stats.id);
                    this.pruneDebugLog();
                }
            });
        });

        // Inject側からの Auto-Gain の状態 (OSD に実効音量と補正量を出すため)
        window.addEventListener('YoutubeVolumeControlGain', (e) => {
            this.autoGainState = e.detail;
            if (this.isAdjustingSettings) return;
            const vol = this.currentReportedVolume !== undefined ? this.currentReportedVolume : (this.intendedVolume || Number(this.settings.defaultVolume));
            this.updateVolumeDisplay(vol);
        });

        // Inject側からの設定要求に対する応答
        window.addEventListener('YoutubeVolumeControlGetSettings', () => {
            this.syncSettingsToInject();
        });

        // --- ユーザー操作の監視 ---

        // マウスダウン・アップ（右クリックスクロールの状態管理）
        // 同時にユーザー操作として記録し、手動でのボリューム変更を許可する
        document.addEventListener('mousedown', (e) => {
            this.onMouseDown(e);
            this.recordUserAction(e);
        }, { capture: true });

        document.addEventListener('mouseup', (e) => this.recordUserAction(e), { capture: true });
        document.addEventListener('keydown', (e) => this.recordUserAction(e), { capture: true });

        // コンテキストメニュー（右クリックメニュー）の制御
        // スクロール操作後はメニューを出さないようにする
        document.addEventListener('contextmenu', (e) => this.onContextMenu(e), true);

        // ホイール操作（音量変更のメイン処理）
        // passive: false にすることで preventDefault() を呼び出し、スクロールをキャンセル可能にする
        window.addEventListener('wheel', (e) => this.onWheel(e), { passive: false, capture: true });

        // --- 動画の状態監視 ---

        // 動画ロード時 (loadeddata)
        document.addEventListener('loadeddata', (e) => {
            const video = e.target;
            if (video.tagName !== 'VIDEO') return;
            this.checkVideoIdAndApply();
        }, { capture: true });

        // SPA遷移対策 (YouTube独自のイベント)
        document.addEventListener('yt-navigate-finish', () => {
            this.checkVideoIdAndApply();
        });

        // 汎用: 動的な要素追加を監視 (MutationObserver)
        // YouTube以外のサイトや、iframe内で遅延ロードされるvideoタグを検知する
        if (!this.observer) {
            this.observer = new MutationObserver((mutations) => {
                let shouldCheck = false;
                for (const mutation of mutations) {
                    if (mutation.addedNodes.length > 0) {
                        for (const node of mutation.addedNodes) {
                            if (node.nodeName === 'VIDEO' || (node.querySelector && node.querySelector('video'))) {
                                shouldCheck = true;
                                break;
                            }
                        }
                    }
                    if (shouldCheck) break;
                }
                if (shouldCheck) {
                    this.checkVideoIdAndApply();
                }
            });
            this.observer.observe(document.body || document.documentElement, {
                childList: true,
                subtree: true
            });
        }

        // Debug情報の受信と表示更新
        window.addEventListener('YoutubeVolumeControlDebug', (e) => {
            const info = e.detail;
            this.debugInfo = info;

            // 設定変更中はOSDの強制上書きを防ぐ
            if (this.isAdjustingSettings) return;

            // 必要に応じてOSD表示を更新
            const vol = this.currentReportedVolume !== undefined ? this.currentReportedVolume : (this.intendedVolume || this.settings.defaultVolume);
            this.updateVolumeDisplay(vol);
        });
    }

    /**
     * デバッグログを新しい順に 50 件までに保つ
     */
    pruneDebugLog() {
        chrome.storage.local.get(null, safeCallback((items) => {
            const keys = Object.keys(items)
                .filter((k) => k.startsWith('dbg:'))
                .sort((a, b) => (items[b].updatedAt || 0) - (items[a].updatedAt || 0));
            if (keys.length > 50) chrome.storage.local.remove(keys.slice(50));
        }));
    }

    /**
     * ユーザーのアクションを記録
     * 「ユーザーが手動で操作した」ことを検知し、自動制御との競合を防ぐために使用
     */
    recordUserAction(e) {
        if (!e || !e.isTrusted) return;

        // 右クリック操作自体は除外（これは当拡張機能のトリガーなので）
        if ((e.type === 'mousedown' || e.type === 'mouseup') && e.button === 2) {
            return;
        }

        // 拡張機能によるホイール操作も除外
        if (e.type === 'wheel' && (e.buttons & 2) === 2 && this.settings.featureEnabled && this.settings.scrollControlEnabled) {
            return;
        }

        this.lastUserActionTime = Date.now();
    }

    onMouseDown(e) {
        // 新しいクリックの開始時はスクロールフラグをリセット
        this.hasScrolled = false;
    }

    onContextMenu(e) {
        // もし右クリック中にスクロール操作が行われていれば、それは「ボリューム操作」として処理済み
        // そのため、コンテキストメニューの表示をブロックする
        if (this.hasScrolled) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            this.hasScrolled = false;
            return false;
        }
    }

    /**
     * inject.js に対して音量変更のロック/解除を指示
     * （ユーザー操作中にAuto-Gainが介入しないようにする等の制御用）
     */
    setVolumeLock(locked) {
        window.dispatchEvent(new CustomEvent('YoutubeVolumeControlLock', { detail: locked }));
    }

    /**
     * ホイールイベントハンドラ
     * 右クリックしながらホイールした時に音量を変更する
     */
    onWheel(e) {
        // 右クリック中 (Bitmask 2) であるかチェック
        if ((e.buttons & 2) === 2 && this.settings.featureEnabled && this.settings.scrollControlEnabled) {
            const video = this.getVideoElement();
            if (video) {
                // ブラウザ標準のページスクロールをキャンセル
                e.preventDefault();
                e.stopPropagation();

                this.hasScrolled = true; // スクロール操作が行われたことをマーク

                // --- ホイールスロットリング (過敏な反応を防止) ---
                // 30ms以内の連続イベントは無視する
                const now = Date.now();
                if (this.lastWheelTime && (now - this.lastWheelTime < 30)) {
                    return;
                }
                this.lastWheelTime = now;

                // 音量変更方向の計算 (deltaY > 0 は下回転＝音量ダウン)
                // stepSizeが文字列として保存されている可能性があるため、確実に数値変換する
                const step = Number(this.settings.stepSize) || 5;
                const delta = e.deltaY > 0 ? -step : step;

                // --- モディファイアキー判定による機能分岐 ---

                // 1. Shift + Wheel: Default Volume 変更 (キー割り当て変更)
                if (e.shiftKey) {
                    let currentDefault = Number(this.settings.defaultVolume) || 50;
                    let newDefault = Math.min(Math.max(currentDefault + delta, 0), 100);

                    this.settings.defaultVolume = newDefault;

                    // 設定調整中フラグを立てる
                    this.isAdjustingSettings = true;
                    if (this.settingsAdjustTimeout) clearTimeout(this.settingsAdjustTimeout);
                    this.settingsAdjustTimeout = setTimeout(() => {
                        this.isAdjustingSettings = false;
                    }, 1500);

                    // ラベルとサブタイトルを指定
                    this.updateVolumeDisplay(newDefault, 'Default', '※デフォルト音量調整中※');

                    // 保存 (デバウンス) & 反映 (即時)
                    this.debouncedSave('defaultVolume', newDefault);
                    this.syncSettingsToInject(); // おそらくinject側で反映処理が必要
                    return;
                }

                // 2. Alt + Wheel: Auto-Gain 目標ラウドネス変更 (1ノッチ = 1dB)
                if (e.altKey) {
                    const currentTarget = Number(this.settings.autoGainTargetLufs);
                    const base = isNaN(currentTarget) ? -16 : currentTarget;
                    const newTarget = Math.min(Math.max(base + (e.deltaY > 0 ? -1 : 1), -40), -6);

                    this.settings.autoGainTargetLufs = newTarget;

                    // 設定調整中フラグを立てる
                    this.isAdjustingSettings = true;
                    if (this.settingsAdjustTimeout) clearTimeout(this.settingsAdjustTimeout);
                    this.settingsAdjustTimeout = setTimeout(() => {
                        this.isAdjustingSettings = false;
                    }, 1500);

                    // ラベルとサブタイトルを指定
                    this.updateVolumeDisplay(newTarget, 'Target', '※目標ラウドネス調整中※', 'LUFS');

                    // 保存 (デバウンス) & 反映 (即時)
                    this.debouncedSave('autoGainTargetLufs', newTarget);
                    this.syncSettingsToInject();
                    return;
                }

                // 3. 通常 (修飾キーなし): 現在の音量変更
                // 現在の音量を取得して新しい音量を計算
                let currentVol = this.currentReportedVolume !== undefined ? this.currentReportedVolume : (video.volume * 100);
                let newVol = Math.min(Math.max(currentVol + delta, 0), 100);

                // 計算誤差などの補正 (小数第1位まで確保)
                newVol = Math.round(newVol * 10) / 10;

                this.intendedVolume = newVol; // 目標値を更新

                // inject.js へ変更要求を送信 (Player APIを使用させるため)
                // video.volumeを直接叩くとOSDが出ないため、inject経由でAPIを叩く
                this.requestVolumeUpdate(newVol);

                // OSDを即座に更新してレスポンスよく見せる
                this.updateVolumeDisplay(newVol);

                // 操作中はAuto-Gainを一時停止させるロックをかける
                this.setVolumeLock(true);

                // ロック解除タイマーのリセット（操作終了から1秒後にロック解除）
                if (this.lockTimeout) clearTimeout(this.lockTimeout);
                this.lockTimeout = setTimeout(() => {
                    this.setVolumeLock(false);
                }, 1000);
            }
        }
    }

    /**
     * inject.js に対して音量変更を要求する
     */
    requestVolumeUpdate(volume) {
        window.dispatchEvent(new CustomEvent('YoutubeVolumeControlSync', {
            detail: volume
        }));
    }

    // Alias for requestVolumeUpdate (used in other methods)
    setYouTubeVolume(video, volume) {
        this.requestVolumeUpdate(volume);
    }

    /**
     * 動画IDチェックと適用処理
     * URLが変わったり動画が変わったりした際に再適用を行う
     */
    async checkVideoIdAndApply() {
        // 設定を再同期して最新の状態にする
        this.syncSettingsToInject();

        // ページをリロードせずに遷移した場合などに、デフォルト音量が適用されない問題を防ぐため
        // ここでも適用ロジックを走らせることができるが、現在はinject.js側の
        // `yt-navigate-start` / `finish` リスナーで強力に制御している。
    }

    /**
     * 音量OSD (On-Screen Display) の表示・更新処理
     * @param {number} value - 表示する値
     * @param {string} label - ラベル (Vol, Target, Default)
     * @param {string} subtitle - (任意) 下部に表示する説明文
     * @param {string} unit - 表示単位 ('%' 以外は値の後ろに空白を挟む)
     */
    updateVolumeDisplay(value, label = 'Vol', subtitle = '', unit = '%') {
        if (!this.settings.osdEnabled) {
            const existing = document.getElementById('yt-vol-control-display');
            if (existing) existing.style.display = 'none';
            return;
        }

        let osd = document.getElementById('yt-vol-control-display');

        // サイトごとのコンテナ要素定義
        let playerContainer = document.querySelector('#movie_player'); // YouTube

        if (!playerContainer) {
            // Twitch
            playerContainer = document.querySelector('.video-player__container');
        }

        if (!playerContainer) {
            // Fallback: video要素の親（ただしvideoタグ自体がラッパーに包まれている場合が多いので、その親など）
            // GreenChannelなどは単純なvideoタグ配置の場合がある
            const vid = this.getVideoElement();
            if (vid) {
                playerContainer = vid.parentElement;
                // コンテナがposition:staticだとOSDの絶対配置が狂うので、relativeにする（副作用注意）
                const style = window.getComputedStyle(playerContainer);
                if (style.position === 'static') {
                    playerContainer.style.position = 'relative';
                }
            }
        }

        // 動画のないフレーム (YouTube のライブチャットの iframe など) では出さない。
        // content script は全フレームで動き、inject.js の状態報告 (Debug) はどのフレームでも届くので、
        // ここで止めないとフレームの右上に OSD が出てしまう
        if (!playerContainer) {
            if (osd) osd.style.display = 'none';
            return;
        }

        if (!osd) {
            osd = document.createElement('div');
            osd.id = 'yt-vol-control-display';
            this.applyOsdStyle(osd);
        }

        // 親要素の確認と再配置
        if (osd.parentElement !== playerContainer) {
            osd.style.position = 'absolute';
            playerContainer.appendChild(osd);
        }

        osd.style.display = 'block';
        osd.style.display = 'block';

        // 通常のポジショニングを適用
        this.applyOsdPosition(osd);

        // 設定変更時（LabelがVol以外）は、画面中央に強制配置する
        // ユーザーが「今設定を変えている」ことを明確にするため
        if (label !== 'Vol') {
            osd.style.top = '50%';
            osd.style.left = '50%';
            osd.style.right = 'auto';
            osd.style.bottom = 'auto';
            osd.style.transform = 'translate(-50%, -50%)';
            osd.style.fontSize = '24px'; // 少し大きくする
            osd.style.padding = '15px 30px';
            osd.style.backgroundColor = 'rgba(0, 0, 0, 0.8)'; // 背景を少し濃く
            osd.style.textAlign = 'center'; // テキスト中央揃え
        } else {
            osd.style.transform = 'none';
            osd.style.fontSize = '14px';
            osd.style.padding = '5px 10px';
            osd.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
            osd.style.textAlign = 'left';
        }

        // Auto-Gain 動作中の音量表示は「実効音量」を大きく出し、2 行目に手動音量と補正量を出す
        // (webaudio では音量の数値を変えずに音声を補正するので、手動音量だけでは効き具合が分からない)
        let detail = '';
        const ag = this.settings.autoGainEnabled ? this.autoGainState : null;
        if (label === 'Vol' && !subtitle && ag) {
            if (ag.state === 'waiting') {
                detail = 'AG 待機中（ページをクリックで開始）';
            } else if (ag.state === 'running') {
                const gain = `AG ${ag.gainDb >= 0 ? '+' : ''}${ag.gainDb.toFixed(1)}dB`;
                if (ag.mode === 'webaudio') {
                    detail = `${Number(value).toFixed(1)}% ${gain}`;
                    value = Number(value) * Math.pow(10, ag.gainDb / 20);
                } else {
                    detail = gain; // legacy はプレイヤー音量そのものを動かすので、表示中の音量が実効音量
                }
            }
        }

        // 小数第1位まで表示
        let text = `${label}: ${Number(value).toFixed(1)}${unit === '%' ? '%' : ' ' + unit}`;
        if (detail) {
            text += `<div style="font-weight: normal; opacity: 0.85;">${detail}</div>`;
        }

        // サブタイトルがあれば改行して追加 (文字サイズ小さめ)
        if (subtitle) {
            text += `<div style="font-size: 0.6em; margin-top: 5px; opacity: 0.9;">${subtitle}</div>`;
        }

        // OSD内部構造の管理
        // テキストとCanvas(Visualizer用)が共存できるようにする
        let textContainer = osd.querySelector('.yt-vol-text');
        if (!textContainer) {
            // テキストコンテナ作成
            textContainer = document.createElement('div');
            textContainer.className = 'yt-vol-text';
            textContainer.style.zIndex = '2'; // Canvasより手前
            textContainer.style.position = 'relative';

            // 既存のコンテンツを整理してテキストコンテナに移動
            if (osd.childNodes.length === 0 || (osd.childNodes.length === 1 && osd.firstChild.nodeType === Node.TEXT_NODE)) {
                textContainer.innerHTML = osd.innerHTML; // innerHTMLで移動
                osd.textContent = '';
                osd.appendChild(textContainer);
            } else {
                osd.insertBefore(textContainer, osd.firstChild);
            }
        }

        textContainer.innerHTML = text; // textContentではなくinnerHTMLを使用

        // デバッグ情報があれば追記
        if (this.settings.showDebugInfo && this.debugInfo) {
            // 以前の挙動に戻す（インライン追加）
            // innerHTMLを使っているため、textContent += ではなく insertAdjacentText を使う
            textContainer.insertAdjacentText('beforeend', ` [${this.debugInfo}]`);
        }

        // フェードアウト処理
        // 操作後2秒で消え始め、0.3秒かけて完全に消える
        if (this.osdTimeout) clearTimeout(this.osdTimeout);
        osd.style.opacity = '1';
        this.osdTimeout = setTimeout(() => {
            osd.style.opacity = '0';
            setTimeout(() => {
                osd.style.display = 'none';
            }, 300); // fade transition time
        }, 1500);
    }

    /**
     * OSDの基本スタイル適用
     */
    applyOsdStyle(osd) {
        osd.style.position = 'absolute';
        osd.style.zIndex = '2147483647'; // 最前面
        osd.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
        osd.style.color = '#fff';
        osd.style.padding = '5px 10px';
        osd.style.fontSize = '14px';
        osd.style.fontWeight = 'bold';
        osd.style.borderRadius = '4px';
        osd.style.pointerEvents = 'none'; // マウスイベント透過
        osd.style.userSelect = 'none';
        osd.style.transition = 'opacity 0.3s ease'; // フェードアニメーション
    }

    /**
     * OSDの位置調整
     * 画面の端から少しマージンを取って配置
     */
    applyOsdPosition(osd) {
        osd.style.top = '10px';
        osd.style.right = '10px';
        osd.style.left = 'auto'; // デフォルト
        osd.style.bottom = 'auto';

        const pos = this.settings.osdPosition;
        // マージン設定 (各端から10px)
        if (pos === 'top-left') {
            osd.style.top = '10px';
            osd.style.left = '10px';
            osd.style.right = 'auto';
        } else if (pos === 'bottom-left') {
            osd.style.bottom = '10px';
            osd.style.left = '10px';
            osd.style.top = 'auto';
            osd.style.right = 'auto';
        } else if (pos === 'bottom-right') {
            osd.style.bottom = '10px';
            osd.style.right = '10px';
            osd.style.top = 'auto';
            osd.style.left = 'auto';
        } else {
            // top-right (default)
            osd.style.top = '10px';
            osd.style.right = '10px';
            osd.style.bottom = 'auto';
            osd.style.left = 'auto';
        }
    }

    checkVideoIdAndApply() {
        // 現在のVideo IDを取得するためのイベントを発行・待機
        const handler = (evt) => {
            window.removeEventListener('YoutubeVolumeControlIdResult', handler);
            const currentVideoId = evt.detail;

            // IDが変わった場合（新しい動画）
            if (currentVideoId && currentVideoId !== this.lastVideoId) {
                this.lastVideoId = currentVideoId;
                this.intendedVolume = null; // 新しい動画なので目標値リセット（デフォルト適用へ）
                this.attemptApplySettings();
            }
        };
        window.addEventListener('YoutubeVolumeControlIdResult', handler);
        window.dispatchEvent(new CustomEvent('YoutubeVolumeControlCheckId'));
    }

    attemptApplySettings() {
        if (!this.settings.featureEnabled) return;

        const maxRetries = 10;
        let attempt = 0;

        // 動画の準備ができるまでリトライしながら適用を試みる
        const tryApply = () => {
            const video = this.getVideoElement();
            if (video) {
                // readyStateに関わらずボリュームは設定可能なので、要素が見つかったら即座に適用する
                const defaultVol = Math.min(Math.max(Number(this.settings.defaultVolume), 0), 100);

                // デフォルト音量を適用 (intendedVolumeもセットして監視ロジックに守らせる)
                this.intendedVolume = defaultVol;
                this.setYouTubeVolume(video, defaultVol);

                // イベントリスナー等はメタデータロード後でも良いが、ボリュームだけは最速で入れる
                if (video.readyState >= 1) {
                    // ネイティブのボリューム変更イベントを監視開始
                    if (this.boundVolumeChange) video.removeEventListener('volumechange', this.boundVolumeChange);
                    this.boundVolumeChange = (e) => this.onVolumeChange(e);
                    video.addEventListener('volumechange', this.boundVolumeChange);

                    // 監視タイマー開始
                    this.startMonitoring(video);

                } else {
                    attempt++;
                    if (attempt < maxRetries) {
                        setTimeout(tryApply, 500); // まだ準備できてなければ500ms後に再試行
                    }
                }
            } else {
                attempt++;
                if (attempt < maxRetries) {
                    setTimeout(tryApply, 100); // video要素が無い場合は短くリトライ
                }
            }
        };
        tryApply();
    }

    startMonitoring(video) {
        if (this.monitorInterval) clearInterval(this.monitorInterval);
        // 1秒ごとにチェックして、意図しない音量変化（ドリフト）があれば修正する
        this.monitorInterval = setInterval(() => {
            this.checkAndRestoreVolume(video);
        }, 1000);
    }

    checkAndRestoreVolume(video) {
        // AutoGain有効時は、音量が動的に変わるのが正常なので、固定値への復元（ドリフト補正）は無効化する
        // ただし、ページ読み込み直後の5秒間は、YouTubeによる勝手な音量復元（例: 99%）を防ぐために
        // 強制的にデフォルト音量を適用し続ける（スタートアップクランプ）
        const isStartupPhase = (Date.now() - (this.initTimestamp || 0)) < 5000;

        if (this.settings.autoGainEnabled && !isStartupPhase) return;

        if (this.intendedVolume === null) return;
        // ユーザーが直近(1秒以内)に手動操作していた場合は、干渉しない（ユーザーの操作中かもしれないので）
        if (Date.now() - this.lastUserActionTime < 1000) return;

        // 現在のボリュームを確認します。ここでも report された値を優先します。
        // Stable Volume環境下では video.volume が信頼できないためです。
        let currentVol = (this.currentReportedVolume !== undefined) ? this.currentReportedVolume : toPercent(video.volume);

        // もし現在値が目標値(intendedVolume)とズレていれば、強制的に戻します
        if (currentVol !== this.intendedVolume) {
            this.setYouTubeVolume(video, this.intendedVolume);
        }
    }

    onVolumeChange(e) {
        const video = e.target;
        // ユーザー操作直後の変化なら、それは「新しい意図」として受け入れます
        if (Date.now() - this.lastUserActionTime < 1000) {
            // ユーザー操作による変更なので、intendedVolumeを更新して追従させる
            // (Reportイベント経由だと遅れたり、フィルタリングされたりするためここで即時反映)
            const currentVol = (this.currentReportedVolume !== undefined) ? this.currentReportedVolume : toPercent(video.volume);
            this.intendedVolume = currentVol;
        } else {
            // ユーザー操作でないのに変わった（勝手に変わった）場合は、自動修正を試みます
            this.checkAndRestoreVolume(video);
        }
    }
}

// クラスをインスタンス化して実行開始
new VolumeController();
