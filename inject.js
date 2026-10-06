/**
 * SmartGain - Injected Script
 * 
 * 役割:
 * 1. Web Audio API を用いた高度な音量制御 (Auto-Gain)
 * 2. HTML5 Video 要素の直接操作 (音量ロック機能用)
 * 3. YouTube Player API (movie_player) へのアクセス
 * 4. Audio Visualizer の描画 (Canvas)
 * 
 * このスクリプトは "page context" で動作するため、
 * window.movie_player や window.AudioContext に直接アクセス可能です。
 */

(function () {
    // 既に注入済みなら何もしない (多重実行防止)
    if (window.YoutubeVolumeControlInjected) return;
    window.YoutubeVolumeControlInjected = true;

    console.log('[SmartGain] Inject script loaded.');

    // --- グローバル状態変数 ---
    let isLocked = false;   // ボリュームロック状態フラグ
    let isClampActive = false; // スタートアップ・クランプ (Proactive Lock) フラグ
    let isSeekActive = false;  // シーク・クランプ (Seek Lock) フラグ
    let originalSet = null; // 本来の volume setter 関数

    // --- ヘルパー関数: ボリューム報告 ---

    // 指定された数値を拡張機能に報告
    const reportVolumeValue = (vol) => {
        // 小数第1位まで含めて報告
        const val = Math.round(vol * 10) / 10;
        window.dispatchEvent(new CustomEvent('YoutubeVolumeControlReport', { detail: val }));
    };

    // ヘルパー: 最適なビデオ要素を取得
    const getBestVideoElement = () => {
        // YouTube
        const ytVideo = document.querySelector('video.html5-main-video');
        if (ytVideo) return ytVideo;

        // Generic
        const videos = document.querySelectorAll('video');
        if (videos.length === 0) return null;
        if (videos.length === 1) return videos[0];

        // 複数ある場合は再生中のものを優先
        for (const v of videos) {
            if (!v.paused && v.readyState > 0) return v;
        }
        return videos[0];
    };

    // --- Twitch: プレイヤー自身の音量を拡張の音量に合わせる ---
    // Twitch は自分の音量 (スライダー・localStorage の "volume") を持っていて、広告明けなどに video.volume へ掛け直す。
    // video.volume だけを変えると、そのときに拡張の音量が Twitch の音量で上書きされるので、Twitch 側も同じ値にしておく
    const isTwitch = /(^|\.)twitch\.tv$/.test(location.hostname);
    const isYouTube = /(^|\.)youtube\.com$/.test(location.hostname);
    const TWITCH_VOLUME_SLIDER = '[data-a-target="player-volume-slider"]';

    // スライダーを操作したのと同じイベントを送り、Twitch の状態・表示・保存値をまとめて更新させる (React の onChange)
    const setTwitchPlayerVolume = (ratio) => {
        if (!isTwitch) return;
        const slider = document.querySelector(TWITCH_VOLUME_SLIDER);
        if (!slider || Math.abs(Number(slider.value) - ratio) < 0.005) return;
        try {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, String(ratio));
            slider.dispatchEvent(new Event('input', { bubbles: true }));
            slider.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) { }
    };

    // プレイヤーが作られる前なら、保存値を書き換えておけば最初からその音量で始まる
    const setTwitchSavedVolume = (ratio) => {
        if (!isTwitch) return;
        try { localStorage.setItem('volume', String(ratio)); } catch (e) { }
    };

    // 現在のPlayer音量を取得して報告
    const reportCurrentVolume = () => {
        try {
            // YouTube
            const player = document.getElementById('movie_player');
            if (player && typeof player.getVolume === 'function') {
                const vol = player.getVolume();
                if (!isNaN(vol)) {
                    reportVolumeValue(vol);
                    return;
                }
            }

            // Fallback: Native HTML5 Video
            const video = getBestVideoElement();
            if (video) {
                // video.volume is 0.0-1.0, convert to 0-100
                reportVolumeValue(video.volume * 100);
            }
        } catch (e) { }
    };

    // --- 1. ネイティブプロパティのフック (Volume Lock機能) ---
    try {
        // HTMLMediaElement.prototype.volume のプロパティ記述子を取得
        const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');

        // setterがあれば（通常あるはず）、それをフックする
        if (descriptor && descriptor.set) {
            originalSet = descriptor.set;
            const originalGet = descriptor.get;

            // HTMLMediaElement.prototype.volume を再定義（オーバーライド）
            Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
                get: function () {
                    // getterはそのまま元の機能を呼び出す（あるいは内部値があればそれを返す）
                    return originalGet ? originalGet.call(this) : this._volume;
                },
                set: function (val) {
                    // 【重要】ここで外部からのボリューム変更を制御します
                    if (isLocked || isClampActive || isSeekActive) {
                        // ロックが有効な場合、またはスタートアップクランプ中、あるいはシーク中は
                        // 外部からの変更を無視します。これによりスパイクを物理的に防ぎます。
                        // console.log(`[SmartGain Hook] Blocked volume change to ${val} (Locked:${isLocked}, Clamp:${isClampActive}, Seek:${isSeekActive})`);
                        return;
                    }
                    // ロックされていなければ、本来のsetterを呼び出して音量を適用します
                    if (originalSet) {
                        // console.log(`[SmartGain Hook] Allowed volume change to ${val}`);
                        originalSet.call(this, val);
                    }
                },
                configurable: true,
                enumerable: true
            });
        }
    } catch (e) {
        console.error('[SmartGain] Failed to hook volume setter:', e);
    }

    // --- 1.5. playメソッドのフック (再生開始時のスパイク対策) ---
    try {
        const originalPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            // グローバルのAGCインスタンスから設定を取得
            const agc = window.YoutubeVolumeControlAgcInstance;
            // スタートアップ・クランプ中に限る。一時停止からの再開でも play() が呼ばれるため、
            // 常に適用するとユーザーが変えた音量がデフォルトに戻ってしまう
            if (agc && agc.defaultVolume !== null && isClampActive) {
                // 再生開始直前にボリュームを強制適用する
                // console.log(`[SmartGain Hook] play() called. Forcing volume to ${agc.defaultVolume}`);

                // 自身のロック機構を一時的に無効化して適用
                const wasClamp = isClampActive;
                isClampActive = false;

                // 0-100 -> 0.0-1.0
                this.volume = agc.defaultVolume / 100;

                isClampActive = wasClamp;
            }
            return originalPlay.apply(this, arguments);
        };
    } catch (e) {
        console.error('[SmartGain] Failed to hook play method:', e);
    }

    // --- 2. イベントリスナー (Content Scriptとの通信) ---

    // ロック制御命令を受信
    window.addEventListener('YoutubeVolumeControlLock', (e) => {
        isLocked = !!e.detail;
    });

    // ボリューム設定命令を受信 (拡張機能からの操作)
    window.addEventListener('YoutubeVolumeControlSync', (e) => {
        try {
            const player = document.getElementById('movie_player');
            if (player && typeof player.setVolume === 'function') {
                const vol = e.detail;

                // 拡張機能からの操作を許可するため、一時的にロックを解除
                const wasLocked = isLocked;
                isLocked = false;

                player.setVolume(vol);

                // 拡張機能からの操作があった場合、AutoGainの内部状態も更新する
                if (window.YoutubeVolumeControlAgcInstance) {
                    window.YoutubeVolumeControlAgcInstance.currentInternalVolume = vol;
                }

                isLocked = wasLocked;
            } else {
                // Fallback: Native HTML5 Video
                const video = document.querySelector('video');
                if (video) {
                    const vol = e.detail;
                    const wasLocked = isLocked;
                    isLocked = false;
                    // Convert 0-100 to 0.0-1.0
                    video.volume = vol / 100;
                    setTwitchPlayerVolume(vol / 100);

                    if (window.YoutubeVolumeControlAgcInstance) {
                        window.YoutubeVolumeControlAgcInstance.currentInternalVolume = vol;
                    }
                    isLocked = wasLocked;
                }
            }
        } catch (e) { }
    });

    // Video IDチェック要求に応答 (動画変更検知用)
    window.addEventListener('YoutubeVolumeControlCheckId', () => {
        try {
            const player = document.getElementById('movie_player');
            if (player && typeof player.getVideoData === 'function') {
                const data = player.getVideoData();
                const videoId = data ? data.video_id : null;
                window.dispatchEvent(new CustomEvent('YoutubeVolumeControlIdResult', { detail: videoId }));
            } else {
                window.dispatchEvent(new CustomEvent('YoutubeVolumeControlIdResult', { detail: null }));
            }
        } catch (e) {
            window.dispatchEvent(new CustomEvent('YoutubeVolumeControlIdResult', { detail: null }));
        }
    });

    // ネイティブの volumechange イベントを監視
    window.addEventListener('volumechange', reportCurrentVolume, true);
    // 保険として定期実行
    setInterval(reportCurrentVolume, 1500);


    // --- Auto-Gain 定数 ---

    const AGC_VERSION = '1.3.0'; // デバッグ表示用。どの版が読み込まれているか確認するため

    // ラウドネス推定の時定数 (秒)。大きいほど「動画全体の平均」寄りになり、ポンピングが減る
    const SPEED_TAU = { fast: 3, normal: 8, slow: 20 };
    const ABS_GATE_LUFS = -60; // これ未満のブロックは無音とみなして推定に使わない
    const REL_GATE_DB = 15;    // 推定値よりこれ以上小さいブロックは「会話の間」などとみなして除外
    const MAX_CUT_DB = 30;
    // AnalyserNode はモノラルにダウンミックスするため、ステレオ合算の LUFS に寄せる補正 (+3dB)
    const LUFS_OFFSET = -0.691 + 3.01;
    const energyToLufs = (ms) => LUFS_OFFSET + 10 * Math.log10(ms);

    // ダイナミクス圧縮プリセット。閾値は目標ラウドネスからの相対値 (正規化後の信号に対して掛けるため)
    // コンプレッサーで削られた分は直後の compMakeup で実測補正するので、圧縮の強さで聞こえる大きさは変わらない
    const COMPRESSION_PRESETS = {
        off: null,
        light: { thresholdOffset: 0, knee: 10, ratio: 2, attack: 0.01, release: 0.3 },
        strong: { thresholdOffset: -6, knee: 10, ratio: 3, attack: 0.005, release: 0.25 }
    };
    // userVol: 手動音量 (0-1)。Chrome では video.volume が Web Audio に入る前に掛かるため、
    // 音量を絞るとコンプレッサーへの入力も下がる。閾値も同じだけ下げないと圧縮が掛からなくなる
    const compressorParams = (name, targetLufs, userVol = 1) => {
        const p = COMPRESSION_PRESETS[name];
        if (!p) return null;
        const volDb = 20 * Math.log10(Math.max(userVol, 0.01));
        return { threshold: targetLufs + p.thresholdOffset + volDb, knee: p.knee, ratio: p.ratio, attack: p.attack, release: p.release };
    };
    const COMP_MAKEUP_RANGE = [-6, 15]; // 圧縮ロス補正 (dB) の範囲
    // ブースト時のクリップ防止用リミッター
    const LIMITER_PARAMS = { threshold: -3, knee: 0, ratio: 20, attack: 0.001, release: 0.1 };

    const applyCompressorParams = (node, p) => {
        node.threshold.value = p.threshold;
        node.knee.value = p.knee;
        node.ratio.value = p.ratio;
        node.attack.value = p.attack;
        node.release.value = p.release;
    };

    // コンプレッサーのメイクアップゲイン (線形) を OfflineAudioContext で実測する
    const makeupCache = new Map();
    const measureMakeup = async (params) => {
        const key = JSON.stringify(params);
        if (makeupCache.has(key)) return makeupCache.get(key);
        let makeup = 1;
        try {
            const sr = 48000;
            const oc = new OfflineAudioContext(1, sr / 2, sr);
            const osc = oc.createOscillator();
            osc.frequency.value = 1000;
            const amp = oc.createGain();
            amp.gain.value = 0.001; // -60dBFS: どのプリセットの閾値よりも十分小さい
            const comp = oc.createDynamicsCompressor();
            applyCompressorParams(comp, params);
            osc.connect(amp).connect(comp).connect(oc.destination);
            osc.start();
            const data = (await oc.startRendering()).getChannelData(0);
            const from = data.length >> 1;
            let sum = 0;
            for (let i = from; i < data.length; i++) sum += data[i] * data[i];
            const rms = Math.sqrt(sum / (data.length - from));
            if (rms > 0 && isFinite(rms)) makeup = rms / (0.001 / Math.SQRT2);
        } catch (e) {
            console.warn('[SmartGain] Makeup calibration failed:', e);
        }
        makeupCache.set(key, makeup);
        return makeup;
    };

    // MediaElementSource は 1 要素につき 1 回しか作れないため、要素ごとに経路を保持する
    const chainByVideo = new WeakMap();

    /**
     * AutoGainController
     * 音量を一定に保つためのメインクラス
     *
     * 2 つの動作モードがある:
     * - webaudio: video → MediaElementSource → GainNode → Compressor → Limiter → 出力
     *   動画のラウドネスを測って GainNode で補正する。プレイヤー音量には触れないので、
     *   手動の音量調整はそのまま「マスター音量」として効く。0dB 超のブーストも可能。
     * - legacy: クロスオリジン等で Web Audio に音声を通せない場合のフォールバック。
     *   captureStream で測定し、プレイヤー音量そのものを操作する (100% が上限)。
     */
    class AutoGainController {
        constructor() {
            // 状態フラグ
            this.enabled = undefined; // Handshake判定用にundefinedで初期化
            this.targetLufs = -16;    // 目標ラウドネス (LUFS 目安)
            this.maxBoostDb = 12;     // 小さい動画を持ち上げる上限
            this.compression = undefined;
            this.intervalId = null;
            this.startPending = false;
            this.mode = null; // 'webaudio' | 'legacy' | null

            // Audio Context 関連
            this.audioCtx = null;
            this.chain = null;          // webaudio モードの処理経路
            this.streamSource = null;   // legacy モードの captureStream ソース
            this.dummyGain = null;      // Chromeバグ対策用のダミーノード (legacy)
            this.meterAnalyser = null;  // ラウドネス測定用 (K特性近似フィルタの後段)
            this.meterBuffer = null;
            this.postBuffer = null;     // コンプレッサー出力の測定用
            this.vizAnalyser = null;    // ビジュアライザー専用 (fftSize を書き換えるため測定用と分ける)

            this.videoElement = null;
            this.zeroRmsCount = 0; // 無音検知カウンター (legacy の再接続判定用)

            // ラウドネス推定 (エネルギー領域の移動平均)
            this.speed = 'normal';
            this.loudnessEnergy = null;
            this.meterBlocks = 0;
            this.currentGainDb = 0;
            this.volCorrDb = 0;         // 手動音量と video.volume の差 (YouTube のラウドネス正規化分) の打ち消し量
            this.lastLoopTime = 0;
            this.lastHref = null;       // ページ内遷移の検知用 (processLoop)
            // 圧縮ロスの推定 (コンプレッサー入力想定値と実出力のエネルギー移動平均)
            this.compInEnergy = null;
            this.compOutEnergy = null;
            this.compMakeupDb = 0;
            this.lastUserVol = 1;

            // 動画ごとの集計 (デバッグログ用。content.js 経由で chrome.storage.local に保存される)
            this.session = null;

            // 初期化・ナビゲーション関連
            this.defaultVolume = null;
            this.initTimestamp = Date.now(); // ページ遷移時刻

            // Visualizer 関連
            this.visualizerEnabled = false;
            this.visualizerType = 'overlay';
            this.canvas = null;
            this.canvasCtx = null;
            this.visualizerReqId = null;

            this.clampInterval = null; // スタートアップクランプ用タイマーID
            this.strictClampListener = null; // 強制クランプ用リスナー
            this.currentInternalVolume = null; // 内部管理用ボリューム（計算のベースに使用）

            this.seekClampTimeout = null; // シーク時のロック解除用タイマー
            this.boundSeekHandler = null; // シークイベントハンドラ
        }

        /**
         * スタートアップ・クランプ (初期音量固定)
         */
        startClamp() {
            // 既存のClampがあればクリア
            if (this.clampInterval) {
                clearInterval(this.clampInterval);
                this.clampInterval = null;
            }
            // リスナー解除 (再入時のクリーンアップ)
            if (this._clampEnforceListener) {
                document.removeEventListener('play', this._clampEnforceListener, { capture: true });
                document.removeEventListener('playing', this._clampEnforceListener, { capture: true });
                document.removeEventListener('loadeddata', this._clampEnforceListener, { capture: true });
                document.removeEventListener('durationchange', this._clampEnforceListener, { capture: true });
                document.removeEventListener('volumechange', this._clampEnforceListener, { capture: true });
                this._clampEnforceListener = null;
            }

            // シーク監視のセットアップ (まだ無ければ)
            this.setupSeekProtection();

            this.reportStatus('Startup Clamp: Active (5s)');

            // Proactive Lock を有効化
            isClampActive = true;
            if (this.defaultVolume !== null) setTwitchSavedVolume(this.defaultVolume / 100);

            // 【即時適用】待たずに一回適用する
            this.enforceDefaultVolume();

            // イベントリスナーによる最速適用 (Captureフェーズで全イベントを監視)
            // 動画要素がまだない場合や、動的に追加される場合に対応するため document で監視する
            const enforce = (e) => {
                // イベントターゲットが動画要素か確認
                if (e.target && e.target.tagName === 'VIDEO') {
                    // 要素が見つかっていない場合は更新
                    if (!this.videoElement) this.videoElement = e.target;
                    this.enforceDefaultVolume();
                }
            };
            this._clampEnforceListener = enforce;

            document.addEventListener('play', enforce, { capture: true });
            document.addEventListener('playing', enforce, { capture: true });
            document.addEventListener('loadeddata', enforce, { capture: true });
            document.addEventListener('durationchange', enforce, { capture: true });

            // 【Strict Clamp】volumechange もキャプチャして即座に書き戻す
            document.addEventListener('volumechange', enforce, { capture: true });

            // ポーリング開始
            let count = 0;
            const startTime = Date.now();
            let playbackDetectedTime = null;

            this.clampInterval = setInterval(() => {
                count++;

                // 再生開始を検知
                const video = this.videoElement || document.querySelector('video');
                if (video && !video.paused && !playbackDetectedTime) {
                    playbackDetectedTime = Date.now();
                }

                // 終了条件:
                // 1. 再生開始から3秒経過
                // 2. または、再生開始しないまま10秒経過 (諦める)
                const now = Date.now();
                const shouldStop = (playbackDetectedTime && (now - playbackDetectedTime) > 3000) ||
                    (!playbackDetectedTime && (now - startTime) > 10000);

                if (shouldStop) {
                    clearInterval(this.clampInterval);
                    this.clampInterval = null;
                    isClampActive = false; // Proactive Lock 解除

                    // リスナー解除
                    if (this._clampEnforceListener) {
                        document.removeEventListener('play', this._clampEnforceListener, { capture: true });
                        document.removeEventListener('playing', this._clampEnforceListener, { capture: true });
                        document.removeEventListener('loadeddata', this._clampEnforceListener, { capture: true });
                        document.removeEventListener('durationchange', this._clampEnforceListener, { capture: true });
                        document.removeEventListener('volumechange', this._clampEnforceListener, { capture: true });
                        this._clampEnforceListener = null;
                    }
                    this.reportStatus('Startup Clamp: Finished');
                    return;
                }

                // 最初の1秒(100回)は10ms間隔、それ以降は100ms間隔 (再生開始後はまた10ms間隔に)
                const isHighPriority = (count <= 100) || (playbackDetectedTime && (now - playbackDetectedTime) < 1000);
                if (!isHighPriority && count % 10 !== 0) return;

                this.enforceDefaultVolume();

            }, 10); // 基本10ms間隔
        }

        /**
         * デフォルト音量を強制適用する実処理
         */
        enforceDefaultVolume() {
            if (this.defaultVolume === null) return;

            if (!this.videoElement) {
                this.videoElement = document.querySelector('video.html5-main-video') || document.querySelector('video');
            }
            setTwitchPlayerVolume(this.defaultVolume / 100);
            if (!this.videoElement) return;

            // クランプ実行
            const currentVol = this.videoElement.volume * 100;
            // 誤差1%以上で強制修正
            // ※ isClampActive = true のままだと setter でブロックされるため、一時的に解除して適用する
            if (Math.abs(currentVol - this.defaultVolume) > 1) {
                const wasClamp = isClampActive;
                isClampActive = false; // 一時解除

                this.videoElement.volume = this.defaultVolume / 100;
                this.currentInternalVolume = this.defaultVolume; // 内部状態も同期

                isClampActive = wasClamp; // 復元
            }
        }

        /**
         * content.js から新しい設定を受け取って反映する
         */
        updateSettings(settings) {
            this.reportStatus('Settings Received');
            this.enabled = settings.autoGainEnabled;
            const target = Number(settings.autoGainTargetLufs);
            const prevTarget = this.targetLufs;
            this.targetLufs = isNaN(target) ? -16 : Math.min(Math.max(target, -40), -6);
            const boost = Number(settings.autoGainMaxBoost);
            this.maxBoostDb = isNaN(boost) ? 12 : Math.min(Math.max(boost, 0), 24);
            this.speed = settings.autoGainSpeed || 'normal';
            this.defaultVolume = settings.defaultVolume;

            // 圧縮プリセットが変わったら経路を組み直す。目標値だけ変わった場合は閾値を追従させる
            const compression = settings.autoGainCompression || 'light';
            if (compression !== this.compression) {
                this.compression = compression;
                if (this.mode === 'webaudio' && this.chain) this.wireChain(this.chain);
            } else if (this.targetLufs !== prevTarget && this.mode === 'webaudio' && this.chain) {
                const params = compressorParams(this.compression, this.targetLufs, this.lastUserVol);
                if (params) applyCompressorParams(this.chain.compressor, params);
            }

            // Visualizer切り替え
            this.visualizerEnabled = settings.visualizerEnabled;
            this.visualizerType = settings.visualizerType || 'overlay';

            // Visualizerセットアップ
            if (this.visualizerEnabled) {
                this.removeVisualizer();
                this.setupVisualizer();
                this.startVisualizerLoop();
            } else {
                this.stopVisualizerLoop();
                this.removeVisualizer();
            }

            // 初回適用時のクランプ開始判定
            if ((Date.now() - this.initTimestamp) < 5000) {
                this.startClamp();
            } else {
                // 5秒経過後でもシーク監視だけは有効化しておく
                this.setupSeekProtection();
            }

            // Auto-Gainの開始/停止
            if (this.enabled) {
                this.start();
            } else {
                this.stop();
            }
        }

        reportStatus(msg) {
            window.dispatchEvent(new CustomEvent('YoutubeVolumeControlDebug', {
                detail: msg
            }));
        }

        /**
         * OSD 表示用に Auto-Gain の状態を content.js へ送る (状態が変わったときと、補正量が変わったときに最大 0.5 秒ごと)
         * @param {'running'|'waiting'|'off'} state waiting = AudioContext がユーザー操作待ち
         * gainDb は動画のラウドネスに対する補正量。webaudio では YouTube の正規化の打ち消し分 (volCorrDb) を除く。
         * これで「手動音量 × 10^(gainDb/20)」が、正規化前の元の音声に対する実効音量になる
         */
        reportGain(state) {
            const gainDb = this.mode === 'webaudio' ? this.currentGainDb - this.volCorrDb : this.currentGainDb;
            const detail = { state, mode: this.mode, gainDb: Math.round(gainDb * 10) / 10 };
            const last = this._lastGainReport;
            const now = Date.now();
            if (last && last.state === detail.state && last.mode === detail.mode) {
                if (last.gainDb === detail.gainDb || now - last.time < 500) return;
            }
            this._lastGainReport = { ...detail, time: now };
            window.dispatchEvent(new CustomEvent('YoutubeVolumeControlGain', { detail }));
        }

        /**
         * AudioContext がユーザー操作待ちで止まっている場合に、操作を契機に再開させる
         * Chrome はページが一度でも操作 (マウスのボタン押下・キー入力) されるまで AudioContext の開始を許さない。
         * 右ボタン＋ホイールの音量操作でも始まるよう、click だけでなく pointerdown / mousedown でも拾う。
         * play イベントはユーザー操作ではない (resume しても拒否され警告が出るだけ) ので契機にしない
         */
        armResume() {
            if (this._resumeArmed) return;
            this._resumeArmed = true;
            const events = ['pointerdown', 'mousedown', 'keydown', 'click'];
            const resumeCtx = () => {
                if (this.audioCtx.state !== 'running') {
                    this.audioCtx.resume();
                    return;
                }
                this._resumeArmed = false;
                events.forEach((t) => window.removeEventListener(t, resumeCtx, { capture: true }));
            };
            events.forEach((t) => window.addEventListener(t, resumeCtx, { capture: true }));
        }

        // 注入前にページが操作済みだった場合などは、イベントを待たずに再開できる
        tryResumeIfActivated() {
            if (navigator.userActivation && navigator.userActivation.hasBeenActive && this.audioCtx.state === 'suspended') {
                this.audioCtx.resume();
            }
        }

        retryStart(ms) {
            this.startPending = true;
            setTimeout(() => {
                this.startPending = false;
                if (this.enabled) this.start();
            }, ms);
        }

        /**
         * 音声を Web Audio に通しても無音化しない (CORS で汚染されない) 動画か判定する
         */
        canRouteThroughWebAudio(video) {
            // Twitch は MSE を Worker で動かしており、srcObject が MediaSourceHandle になる (MSE なので同一オリジン扱い)
            if (typeof MediaSourceHandle !== 'undefined' && video.srcObject instanceof MediaSourceHandle) return true;
            const src = video.currentSrc || video.src || '';
            if (!src) return false; // srcObject (MediaStream) 等
            // YouTube は MSE の blob: URL なので同一オリジン扱い
            if (src.startsWith('blob:') || src.startsWith('data:')) return true;
            // crossorigin 属性付きで読めているなら CORS 許可済み
            if (video.crossOrigin !== null) return true;
            try {
                return new URL(src, location.href).origin === location.origin;
            } catch (e) {
                return false;
            }
        }

        /**
         * ラウドネス測定用ブランチ (BS.1770 の K 特性を Biquad で近似)
         * K 特性は低音をほとんど割り引かず、低音の多い曲を「大きい」と見積もって下げすぎるため、
         * 120Hz のハイパスを追加して中高域 (ボーカル等) の聞こえ方に寄せている
         */
        createMeter(input) {
            const ctx = this.audioCtx;
            const hpf = ctx.createBiquadFilter();
            hpf.type = 'highpass';
            hpf.frequency.value = 38;
            hpf.Q.value = 0.5;
            const shelf = ctx.createBiquadFilter();
            shelf.type = 'highshelf';
            shelf.frequency.value = 1500;
            shelf.gain.value = 4;
            const bassCut = ctx.createBiquadFilter();
            bassCut.type = 'highpass';
            bassCut.frequency.value = 120;
            bassCut.Q.value = Math.SQRT1_2;
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 4096; // 48kHz で約 85ms。100ms 周期のポーリングでほぼ全区間を測れる
            hpf.connect(shelf);
            shelf.connect(bassCut);
            bassCut.connect(analyser);
            if (input) input.connect(hpf);
            return { input: hpf, analyser };
        }

        buildChain(video) {
            const ctx = this.audioCtx;
            const src = ctx.createMediaElementSource(video); // 他スクリプトが使用済みなら例外 → legacy へ
            const meter = this.createMeter(null);
            const postMeter = this.createMeter(null);
            const outMeter = this.createMeter(null);
            const chain = {
                video,
                src,
                meterInput: meter.input,
                meter: meter.analyser,
                postMeterInput: postMeter.input,
                postMeter: postMeter.analyser,
                outMeterInput: outMeter.input,
                outMeter: outMeter.analyser,
                normGain: ctx.createGain(),
                compressor: ctx.createDynamicsCompressor(),
                compMakeup: ctx.createGain(),
                limiter: ctx.createDynamicsCompressor(),
                outGain: ctx.createGain(),
                vizAnalyser: ctx.createAnalyser()
            };
            applyCompressorParams(chain.limiter, LIMITER_PARAMS);
            // 別の動画が読み込まれたら推定をやり直す (YouTube は同じ video 要素を使い回す)。
            // YouTube は同じ動画の再生途中でも MediaSource を作り直すことがあり、そこでリセットすると
            // ブーストが一瞬 0dB に落ちるので、動画 ID が変わっていなければ何もしない
            video.addEventListener('loadedmetadata', () => {
                if (this.chain !== chain) return;
                const key = this.getVideoKey(video);
                if (key && key === chain.videoKey) return;
                this.resetMeter();
            });
            return chain;
        }

        // YouTube の動画 ID (取れなければ null = 毎回別の動画とみなす)
        getVideoKey(video) {
            try {
                const player = document.getElementById('movie_player');
                if (player && typeof player.getVideoData === 'function' && player.contains(video)) {
                    return player.getVideoData().video_id || null;
                }
            } catch (e) { }
            return null;
        }

        wireChain(chain) {
            const { src, normGain, compressor, compMakeup, limiter, outGain } = chain;
            [src, normGain, compressor, compMakeup, limiter, outGain].forEach((n) => {
                try { n.disconnect(); } catch (e) { }
            });

            src.connect(chain.meterInput);
            src.connect(normGain);

            // 圧縮ロス推定をやり直す
            this.compInEnergy = null;
            this.compOutEnergy = null;
            this.compMakeupDb = 0;
            compMakeup.gain.cancelScheduledValues(0);
            compMakeup.gain.value = 1;

            const params = compressorParams(this.compression, this.targetLufs, this.lastUserVol);
            if (params) {
                applyCompressorParams(compressor, params);
                normGain.connect(compressor);
                compressor.connect(compMakeup);
                compressor.connect(chain.postMeterInput);
                compMakeup.connect(limiter);
                // 推定が立つまでの初期値: Chrome の自動メイクアップゲインを打ち消して閾値以下を等倍にする
                measureMakeup(params).then((m) => {
                    if (this.compOutEnergy === null) {
                        this.compMakeupDb = -20 * Math.log10(m);
                        compMakeup.gain.value = 1 / m;
                    }
                });
            } else {
                normGain.connect(limiter);
            }
            limiter.connect(outGain);
            outGain.connect(this.audioCtx.destination);
            outGain.connect(chain.vizAnalyser);
            outGain.connect(chain.outMeterInput);

            // リミッターのメイクアップゲインは固定なので実測して打ち消す。実測が終わるまでは控えめ (-6dB) にしておく
            if (!makeupCache.has(JSON.stringify(LIMITER_PARAMS))) outGain.gain.value = 0.5;
            measureMakeup(LIMITER_PARAMS).then((lim) => {
                outGain.gain.value = 1 / lim;
            });
        }

        // 処理を外して素通しにする (MediaElementSource は作り直せないので切断ではなく直結)
        bypassChain(chain) {
            const { src, normGain, compressor, compMakeup, limiter, outGain } = chain;
            [src, normGain, compressor, compMakeup, limiter, outGain].forEach((n) => {
                try { n.disconnect(); } catch (e) { }
            });
            src.connect(this.audioCtx.destination);
        }

        ensureChain(video) {
            let chain = chainByVideo.get(video);
            if (!chain) {
                try {
                    chain = this.buildChain(video);
                } catch (e) {
                    console.warn('[SmartGain] MediaElementSource unavailable, falling back:', e);
                    return null;
                }
                chainByVideo.set(video, chain);
            }
            this.wireChain(chain);
            return chain;
        }

        /**
         * Auto-Gainの処理を開始
         */
        async start() {
            if (this.intervalId || this.startPending) return; // 既に動作中 / 再試行待ち

            try {
                // コンテキスト作成
                if (!this.audioCtx) {
                    const AudioContext = window.AudioContext || window.webkitAudioContext;
                    this.audioCtx = new AudioContext();
                    this.audioCtx.addEventListener('statechange', () => {
                        if (this.audioCtx.state !== 'running') this.armResume();
                    });
                }
                if (this.audioCtx.state !== 'running') this.armResume();

                // ビデオ要素の取得
                const video = getBestVideoElement();
                if (!video || video.readyState < 2) {
                    this.reportStatus('Waiting for video ready (RS < 2)...');
                    this.retryStart(1000);
                    return;
                }
                this.videoElement = video;

                if (this.canRouteThroughWebAudio(video)) {
                    if (this.audioCtx.state !== 'running') {
                        // 停止中の AudioContext に音声を通すと無音になるため、再開できるまでは素通しで待つ
                        this.tryResumeIfActivated();
                        this.reportStatus('Waiting for AudioContext (click the page)...');
                        this.reportGain('waiting');
                        this.retryStart(1000);
                        return;
                    }
                    const chain = this.ensureChain(video);
                    if (chain) {
                        this.chain = chain;
                        this.mode = 'webaudio';
                        this.meterAnalyser = chain.meter;
                        this.vizAnalyser = chain.vizAnalyser;
                        this.resetMeter();
                    }
                }

                // フォールバック: captureStream で測定のみ行う
                if (!this.mode) {
                    let stream = null;
                    try {
                        if (video.captureStream) stream = video.captureStream();
                        else if (video.mozCaptureStream) stream = video.mozCaptureStream();
                    } catch (e) {
                        console.warn('[SmartGain] captureStream failed (likely EME/DRM protected):', e);
                    }

                    if (stream && stream.getAudioTracks().length > 0) {
                        this.streamSource = this.audioCtx.createMediaStreamSource(stream);
                        this.meterAnalyser = this.createMeter(this.streamSource).analyser;
                        this.vizAnalyser = this.audioCtx.createAnalyser();
                        this.streamSource.connect(this.vizAnalyser);

                        // Chromeバグ対策: ダミーゲイン
                        this.dummyGain = this.audioCtx.createGain();
                        this.dummyGain.gain.value = 0.0;
                        this.dummyGain.connect(this.audioCtx.destination);
                        this.streamSource.connect(this.dummyGain);
                        this.mode = 'legacy';
                        this.resetMeter();
                    }
                }

                // メインループ開始
                if (this.meterAnalyser) {
                    this.meterBuffer = new Float32Array(this.meterAnalyser.fftSize);
                    this.postBuffer = new Float32Array(this.meterAnalyser.fftSize);
                    this.outBuffer = new Float32Array(this.meterAnalyser.fftSize);
                    this.lastLoopTime = 0;
                    this.intervalId = setInterval(() => this.processLoop(), 100);
                    this.reportStatus(`Running [${this.mode}]`);
                    this.reportGain(this.audioCtx.state === 'running' ? 'running' : 'waiting');
                } else {
                    this.reportStatus('No audio source available');
                }
            } catch (e) {
                console.error('[SmartGain] AutoGain Start Error:', e);
                this.reportStatus('Error: ' + e.message);
            }
        }

        stop() {
            if (this.intervalId) {
                clearInterval(this.intervalId);
                this.intervalId = null;
            }
            if (this.chain) {
                this.bypassChain(this.chain);
                this.chain = null;
            }
            if (this.streamSource) {
                this.streamSource.disconnect();
                this.streamSource = null;
            }
            if (this.dummyGain) {
                this.dummyGain.disconnect();
                this.dummyGain = null;
            }
            this.meterAnalyser = null;
            this.vizAnalyser = null;
            this.mode = null;
            this.currentGainDb = 0;
            this.reportStatus('Stopped (Graph Cleared)');
            this.reportGain('off');
        }

        /**
         * 動画が切り替わったときの処理
         */
        handleNavigation() {
            if (!this.enabled) return;
            if (this.mode === 'webaudio' && this.chain && this.chain.video === getBestVideoElement()) {
                this.resetMeter();
                return;
            }
            this.stop();
            setTimeout(() => this.start(), 1000);
        }

        /**
         * 新しい動画向けにラウドネス推定をやり直す。
         * 直前の推定値は「1 ブロック分の事前値」として残し、最初の数秒は累積平均で素早く収束させる。
         */
        resetMeter() {
            if (this.chain) this.chain.videoKey = this.getVideoKey(this.chain.video);
            this.startSession();
            this.meterBlocks = this.loudnessEnergy === null ? 0 : 1;
            // 前の動画で大きくブーストしていた場合、次の動画の冒頭が爆音にならないよう 0dB に戻しておく
            if (this.mode === 'webaudio' && this.currentGainDb > 0) this.applyGain(0, 0.05);
        }

        // 手動音量 (0-1)。ミュート時は null
        getUserVolumeRatio(video) {
            if (video.muted) return null;
            const player = document.getElementById('movie_player');
            if (player && typeof player.getVolume === 'function' && player.contains(video)) {
                if (typeof player.isMuted === 'function' && player.isMuted()) return null;
                const vol = player.getVolume();
                if (typeof vol === 'number' && !isNaN(vol)) return vol / 100;
            }
            return video.volume;
        }

        applyGain(gainDb, timeConstant = 0.3) {
            if (this.mode === 'webaudio') {
                if (Math.abs(gainDb - this.currentGainDb) < 0.1) return;
                const param = this.chain.normGain.gain;
                param.setTargetAtTime(Math.pow(10, gainDb / 20), this.audioCtx.currentTime, timeConstant);
                this.currentGainDb = gainDb;
                return;
            }

            // legacy: プレイヤー音量で補正する。基準はデフォルト音量。
            const video = this.videoElement;
            if (!video) return;
            const player = document.getElementById('movie_player');
            const useNative = (!player || typeof player.getVolume !== 'function');
            const ref = Math.min(Math.max(Number(this.defaultVolume) || 50, 0), 100);

            // YouTube のラウドネス正規化で video.volume がプレイヤー音量より下げられている分を打ち消す
            let currentVolume = video.volume * 100;
            let ytFactor = 1;
            if (!useNative) {
                currentVolume = player.getVolume();
                if (currentVolume > 0) {
                    ytFactor = Math.min(Math.max(video.volume / (currentVolume / 100), 0.05), 1);
                }
            }
            const newVolume = Math.min(Math.max(ref * Math.pow(10, gainDb / 20) / ytFactor, 0), 100);
            this.currentGainDb = gainDb;
            if (Math.abs(newVolume - currentVolume) < 0.3) return;

            // 適用 (自身による変更時はロック無視)
            const wasLocked = isLocked;
            isLocked = false;
            if (!useNative) {
                player.setVolume(newVolume);
            } else {
                video.volume = newVolume / 100;
            }
            isLocked = wasLocked;
            reportVolumeValue(newVolume);
        }

        /**
         * メイン処理ループ (100ms周期)
         */
        processLoop() {
            const now = performance.now();
            const dt = this.lastLoopTime ? Math.min((now - this.lastLoopTime) / 1000, 2) : 0.1;
            this.lastLoopTime = now;

            const video = this.mode === 'webaudio' ? this.chain.video : this.videoElement;
            if (!this.meterAnalyser || !video) {
                this.reportStatus('Loop: Not Ready');
                return;
            }

            // 対象の動画が止まって/外れて、別の要素が再生されている (Twitch 等) 場合は繋ぎ直す
            const best = getBestVideoElement();
            if (best && best !== video && !best.paused && (video.paused || !video.isConnected)) {
                this.stop();
                this.start();
                return;
            }

            // ページ内遷移 (Twitch のチャンネル・録画の切り替え等) で同じ video 要素に別の動画が流れたら推定をやり直す。
            // やり直さないと前の動画の推定を引きずり、移動平均で追いつくまで数十秒ずれたままになる。
            // YouTube は yt-navigate-finish (handleNavigation) で同じことをしているので除く
            if (location.href !== this.lastHref) {
                if (this.lastHref && !isYouTube) this.resetMeter();
                this.lastHref = location.href;
            }

            if (video.paused) {
                this.reportStatus('Loop: Video Paused');
                return;
            }
            if (this.audioCtx.state !== 'running') {
                this.reportStatus('Loop: Ctx Suspended');
                this.reportGain('waiting');
                return;
            }

            // webaudio モードでは測定値に video.volume が掛かっているので割り戻し、動画そのもののラウドネスを測る。
            // legacy (captureStream) は仕様上 volume の影響を受けない。
            const userVol = this.mode === 'webaudio' ? this.getUserVolumeRatio(video) : 1;
            const elemVol = this.mode === 'webaudio' ? video.volume : 1;
            if (userVol === null || userVol < 0.01 || elemVol < 0.001) {
                this.reportStatus('Loop: Muted');
                return;
            }
            // YouTube は video.volume を「手動音量 × 自前のラウドネス正規化」にしており、正規化分を再生途中で
            // 掛け直すことがある (スタートアップ・クランプで上書きした後など)。推定の移動平均で追うと
            // 数十秒「急に小さい」状態が続くので、手動音量との差は推定と切り離して即座に打ち消す
            this.volCorrDb = 20 * Math.log10(userVol / elemVol);

            const buf = this.meterBuffer;
            this.meterAnalyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const rawMs = sum / buf.length;
            const ms = rawMs / (elemVol * elemVol);
            const blockLufs = ms > 0 ? energyToLufs(ms) : -Infinity;

            // 無音ブロックは推定に使わない (無音を持ち上げないため)
            if (blockLufs < ABS_GATE_LUFS) {
                if (this.mode === 'legacy' && !video.muted) {
                    this.zeroRmsCount++;
                    if (this.zeroRmsCount > 30) {
                        this.reportStatus('Signal Lost. Re-capturing...');
                        this.zeroRmsCount = 0;
                        this.stop();
                        setTimeout(() => this.start(), 500);
                        return;
                    }
                }
                this.reportStatus(`[${this.mode}] Silence G:${this.formatDb(this.currentGainDb)}`);
                return;
            }
            this.zeroRmsCount = 0;

            // 会話の間などの小さいブロックも除外 (間に引きずられて持ち上げすぎないため)
            if (this.loudnessEnergy !== null && this.meterBlocks >= 20 &&
                blockLufs < energyToLufs(this.loudnessEnergy) - REL_GATE_DB) {
                this.reportDebug(blockLufs, true);
                return;
            }

            // エネルギー領域の移動平均。リセット直後は累積平均として振る舞い、素早く収束させる
            const tau = SPEED_TAU[this.speed] || SPEED_TAU.normal;
            this.meterBlocks++;
            const alpha = this.loudnessEnergy === null ? 1 : Math.max(1 / this.meterBlocks, 1 - Math.exp(-dt / tau));
            this.loudnessEnergy = this.loudnessEnergy === null ? ms : this.loudnessEnergy + (ms - this.loudnessEnergy) * alpha;

            const loudness = energyToLufs(this.loudnessEnergy);
            const gainDb = Math.min(Math.max(this.targetLufs - loudness + this.volCorrDb, -MAX_CUT_DB), this.maxBoostDb);

            // legacy はスタートアップ・シーク中のロックやページ読み込み直後は適用しない (測定だけ続ける)
            const legacyHold = this.mode === 'legacy' &&
                (isClampActive || isSeekActive || isLocked || (Date.now() - this.initTimestamp) < 2000);
            if (!legacyHold) this.applyGain(gainDb);
            this.reportGain('running');

            if (this.mode === 'webaudio') this.updateCompMakeup(rawMs, alpha, userVol);

            // 入力L は従来どおり YouTube の正規化込み (手動音量 100% 換算) で記録する
            this.recordStats(rawMs / (userVol * userVol), userVol, dt);
            this.reportDebug(blockLufs, false);
        }

        // --- デバッグログ (動画ごとの集計) ---

        startSession() {
            this.emitSession();
            this.session = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                startedAt: Date.now(),
                url: null, // 動画の識別情報は再生が進んでから取る (遷移直後はタイトル等が前の動画のままのことがある)
                videoId: null,
                title: null,
                version: AGC_VERSION,
                mode: this.mode,
                settings: { target: this.targetLufs, compression: this.compression, speed: this.speed, maxBoost: this.maxBoostDb },
                seconds: 0, blocks: 0,
                preE: 0, outE: 0, outBlocks: 0,
                volSum: 0, gainSum: 0, cSum: 0, grSum: 0,
                secE: 0, secN: 0, outSec: [],
                lastEmit: Date.now()
            };
        }

        // 推定に使った (ゲートを通った) ブロックだけを集計する
        recordStats(preMs, userVol, dt) {
            const s = this.session;
            if (!s) return;
            s.mode = this.mode;
            if (!s.url && s.seconds > 3) {
                s.url = location.href;
                s.title = document.title.replace(/ - YouTube$/, '');
                try {
                    const player = document.getElementById('movie_player');
                    if (player && typeof player.getVideoData === 'function') s.videoId = player.getVideoData().video_id || null;
                } catch (e) { }
            }
            s.seconds += dt;
            s.blocks++;
            s.preE += preMs;
            s.volSum += userVol;
            s.gainSum += this.currentGainDb;
            if (this.mode === 'webaudio') {
                const hasComp = !!compressorParams(this.compression, this.targetLufs);
                if (hasComp) {
                    s.cSum += this.compMakeupDb;
                    s.grSum += this.chain.compressor.reduction;
                }
                // 最終出力 (手動音量で割り戻して 100% 換算)
                const out = this.outBuffer;
                this.chain.outMeter.getFloatTimeDomainData(out);
                let sum = 0;
                for (let i = 0; i < out.length; i++) sum += out[i] * out[i];
                const outMs = sum / out.length / (userVol * userVol);
                s.outE += outMs;
                s.outBlocks++;
                s.secE += outMs;
                s.secN++;
                if (s.secN >= 10) { // 約 1 秒ごとの出力ラウドネス (ばらつきの指標)
                    if (s.outSec.length < 7200) s.outSec.push(energyToLufs(s.secE / s.secN));
                    s.secE = 0;
                    s.secN = 0;
                }
            }
            if (Date.now() - s.lastEmit > 5000) this.emitSession();
        }

        emitSession() {
            const s = this.session;
            if (!s || s.blocks < 10) return;
            s.lastEmit = Date.now();
            const r1 = (v) => (v === null || !isFinite(v)) ? null : Math.round(v * 10) / 10;
            const pct = (arr, p) => {
                if (arr.length === 0) return null;
                const sorted = [...arr].sort((a, b) => a - b);
                return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
            };
            const hasComp = !!compressorParams(s.settings.compression, s.settings.target);
            window.dispatchEvent(new CustomEvent('YoutubeVolumeControlStats', {
                detail: {
                    id: s.id,
                    startedAt: s.startedAt,
                    updatedAt: Date.now(),
                    url: s.url,
                    videoId: s.videoId,
                    title: s.title,
                    version: s.version,
                    mode: s.mode,
                    settings: s.settings,
                    seconds: Math.round(s.seconds),
                    userVol: r1(s.volSum / s.blocks * 100),
                    inL: r1(energyToLufs(s.preE / s.blocks)),
                    gain: r1(s.gainSum / s.blocks),
                    comp: hasComp ? r1(s.cSum / s.blocks) : null,
                    gr: hasComp ? r1(s.grSum / s.blocks) : null,
                    outL: s.outBlocks ? r1(energyToLufs(s.outE / s.outBlocks)) : null,
                    outP10: r1(pct(s.outSec, 0.1)),
                    outP90: r1(pct(s.outSec, 0.9))
                }
            }));
        }

        /**
         * コンプレッサーで削られた平均量を実測し、直後の compMakeup で戻す。
         * 低音の多い曲ほどコンプレッサーが強く掛かり小さく聞こえる偏りを打ち消すため。
         * (ゲインを足すのはコンプレッサーの後段なので、補正がさらに圧縮される循環は起きない)
         * @param {number} rawMs 手動音量で割り戻す前の入力側ブロックエネルギー
         */
        updateCompMakeup(rawMs, alpha, userVol) {
            const params = compressorParams(this.compression, this.targetLufs, userVol);
            if (!params) return;
            // 手動音量が変わったら閾値を追従させる (0.5dB 未満の変化は無視)
            if (Math.abs(params.threshold - this.chain.compressor.threshold.value) > 0.5) {
                this.chain.compressor.threshold.value = params.threshold;
            }
            this.lastUserVol = userVol;
            const post = this.postBuffer;
            this.chain.postMeter.getFloatTimeDomainData(post);
            let sum = 0;
            for (let i = 0; i < post.length; i++) sum += post[i] * post[i];
            const outMs = sum / post.length;
            const g = this.chain.normGain.gain.value;
            const inMs = rawMs * g * g; // コンプレッサーが無ければ出ていたはずのエネルギー
            if (!(outMs > 0) || !(inMs > 0)) return;

            if (this.compOutEnergy === null) {
                this.compInEnergy = inMs;
                this.compOutEnergy = outMs;
            } else {
                this.compInEnergy += (inMs - this.compInEnergy) * alpha;
                this.compOutEnergy += (outMs - this.compOutEnergy) * alpha;
            }
            const [lo, hi] = COMP_MAKEUP_RANGE;
            const db = Math.min(Math.max(10 * Math.log10(this.compInEnergy / this.compOutEnergy), lo), hi);
            if (Math.abs(db - this.compMakeupDb) < 0.1) return;
            this.chain.compMakeup.gain.setTargetAtTime(Math.pow(10, db / 20), this.audioCtx.currentTime, 0.3);
            this.compMakeupDb = db;
        }

        formatDb(db) {
            return `${db >= 0 ? '+' : ''}${db.toFixed(1)}dB`;
        }

        reportDebug(blockLufs, gated) {
            const loudness = this.loudnessEnergy !== null ? energyToLufs(this.loudnessEnergy).toFixed(1) : '--';
            let msg = `[${this.mode} v${AGC_VERSION}] L:${loudness} Blk:${blockLufs.toFixed(1)}${gated ? '(gated)' : ''}` +
                ` T:${this.targetLufs} G:${this.formatDb(this.currentGainDb)}`;
            if (Math.abs(this.volCorrDb) >= 0.1) msg += ` V:${this.formatDb(this.volCorrDb)}`;
            if (this.mode === 'webaudio' && COMPRESSION_PRESETS[this.compression]) {
                msg += ` GR:${this.chain.compressor.reduction.toFixed(1)} C:${this.formatDb(this.compMakeupDb)}`;
            }
            this.reportStatus(msg);
        }

        // --- Visualizer 関連 ---

        setupVisualizer() {
            if (this.canvas) return;
            // 付け先がまだ無い (inject.js は document_start で動くので body 生成前のことがある / OSD 未表示) 場合は
            // 何もせず、描画ループ側で再試行する
            const isOsd = this.visualizerType === 'osd' || this.visualizerType === 'osd_bottom';
            const parent = isOsd ? document.getElementById('yt-vol-control-display') : document.body;
            if (!parent) return;
            this.canvas = document.createElement('canvas');

            if (isOsd) {
                this.canvas.style.width = '100%';
                this.canvas.style.height = this.visualizerType === 'osd' ? '100%' : '30px';
                this.canvas.style.position = this.visualizerType === 'osd' ? 'absolute' : 'relative';
                this.canvas.style.top = '0';
                this.canvas.style.left = '0';
                this.canvas.style.zIndex = '1';
                this.canvas.style.opacity = '0.5';
                this.canvas.style.pointerEvents = 'none';
            } else {
                this.canvas.style.position = 'fixed';
                this.canvas.style.bottom = '10px';
                this.canvas.style.left = '50%';
                this.canvas.style.transform = 'translateX(-50%)';
                this.canvas.style.width = '300px';
                this.canvas.style.height = '60px';
                this.canvas.style.zIndex = '2147483646';
                this.canvas.style.pointerEvents = 'none';
            }
            parent.appendChild(this.canvas);

            this.canvasCtx = this.canvas.getContext('2d');
        }

        removeVisualizer() {
            if (this.canvas) {
                if (this.canvas.parentElement) {
                    this.canvas.parentElement.removeChild(this.canvas);
                }
                this.canvas = null;
                this.canvasCtx = null;
            }
        }

        startVisualizerLoop() {
            if (this.visualizerReqId) cancelAnimationFrame(this.visualizerReqId);

            const draw = () => {
                this.visualizerReqId = requestAnimationFrame(draw);

                // 未設置 / ページ側に消された (OSD の作り直し等) 場合は付け直す
                if (!this.canvas || !document.contains(this.canvas)) {
                    this.removeVisualizer();
                    this.setupVisualizer();
                    return;
                }

                if (!this.vizAnalyser || !this.canvas || !this.canvasCtx) return;

                const width = this.canvas.clientWidth;
                const height = this.canvas.clientHeight;
                if (this.canvas.width !== width || this.canvas.height !== height) {
                    this.canvas.width = width;
                    this.canvas.height = height;
                }

                const ctx = this.canvasCtx;
                ctx.clearRect(0, 0, width, height);

                // イコライザー (OSD Bottom)
                if (this.visualizerType === 'osd_bottom') {
                    this.vizAnalyser.fftSize = 64;
                    const bufferLength = this.vizAnalyser.frequencyBinCount;
                    const dataArray = new Uint8Array(bufferLength);
                    this.vizAnalyser.getByteFrequencyData(dataArray);

                    const gradient = ctx.createLinearGradient(0, height, 0, 0);
                    gradient.addColorStop(0, 'rgb(0, 255, 0)');
                    gradient.addColorStop(0.5, 'rgb(255, 255, 0)');
                    gradient.addColorStop(1, 'rgb(255, 0, 0)');
                    ctx.fillStyle = gradient;

                    const barWidth = (width / bufferLength) * 0.8;
                    let x = 0;

                    for (let i = 0; i < bufferLength; i++) {
                        const barHeight = (dataArray[i] / 255) * height;
                        ctx.fillRect(x, height - barHeight, barWidth, barHeight);
                        x += (width / bufferLength);
                    }
                    return;
                }

                // 波形 (Overlay / OSD)
                this.vizAnalyser.fftSize = 256;
                const bufferLength = this.vizAnalyser.fftSize;
                const dataArray = new Uint8Array(bufferLength);
                this.vizAnalyser.getByteTimeDomainData(dataArray);

                ctx.lineWidth = 2;
                let color = 'rgba(0, 255, 255, 0.8)';
                if (this.visualizerType === 'osd') color = 'rgba(0, 255, 127, 0.8)';

                ctx.strokeStyle = color;
                ctx.beginPath();

                const sliceWidth = width * 1.0 / bufferLength;
                let x = 0;

                for (let i = 0; i < bufferLength; i++) {
                    const v = dataArray[i] / 128.0;
                    const y = v * height / 2;
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                    x += sliceWidth;
                }
                ctx.lineTo(width, height / 2);
                ctx.stroke();
            };
            draw();
        }

        stopVisualizerLoop() {
            if (this.visualizerReqId) {
                cancelAnimationFrame(this.visualizerReqId);
                this.visualizerReqId = null;
            }
        }

        // --- シーク対策 (Proactive Lock for Seeking) ---

        setupSeekProtection() {
            const video = this.videoElement || document.querySelector('video');
            if (!video) return;

            // リスナー重複登録防止
            if (this.boundSeekHandler) {
                video.removeEventListener('seeking', this.boundSeekHandler);
            }

            this.boundSeekHandler = () => this.triggerSeekClamp();
            video.addEventListener('seeking', this.boundSeekHandler);
        }

        triggerSeekClamp() {
            // シーク開始を検知
            // this.reportStatus('Seeking detected. Locking volume...');

            // 既にスタートアップクランプ中なら何もしない（最強のロックがかかっているため）
            if (isClampActive) return;

            // ロック有効化
            isSeekActive = true;

            // 既存の解除タイマーをリセット
            if (this.seekClampTimeout) clearTimeout(this.seekClampTimeout);

            // 1秒後に解除
            this.seekClampTimeout = setTimeout(() => {
                isSeekActive = false;
                this.seekClampTimeout = null;
            }, 1000);
        }
    }

    // --- メイン初期化 ---

    const agc = new AutoGainController();
    // 外部からインスタンスにアクセスできるようにグローバルに公開 (イベントハンドラ内での参照用)
    window.YoutubeVolumeControlAgcInstance = agc;

    // 設定受信
    window.addEventListener('YoutubeVolumeControlSettings', (e) => {
        if (e.detail) {
            agc.updateSettings(e.detail);
        }
    });

    // YouTubeページ遷移時(SPA)のリセット処理
    window.addEventListener('yt-navigate-start', () => {
        agc.initTimestamp = Date.now();
        if (agc.defaultVolume !== null) {
            agc.startClamp();
        }
    });

    window.addEventListener('yt-navigate-finish', () => {
        agc.initTimestamp = Date.now();
        agc.videoElement = null;

        if (agc.defaultVolume !== null) {
            agc.startClamp();
        }

        agc.handleNavigation();
    });

    // Handshake: 設定要求
    agc.reportStatus('Handshake: Requesting...');
    const handshakeInterval = setInterval(() => {
        if (agc.enabled !== undefined) {
            clearInterval(handshakeInterval);
            return;
        }
        window.dispatchEvent(new CustomEvent('YoutubeVolumeControlGetSettings'));
    }, 500);

})();
