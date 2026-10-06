# test — 実サイトでの検証スクリプト

SmartGain（リポジトリ直下の拡張）を実際の Twitch / YouTube で動かして挙動を記録するスクリプト。ユーザーに実機確認を頼む前に、まずこれで確かめる。

## 前提

- ホストの python3 に Playwright がある（`~/.local/lib/python3.10/site-packages/playwright`）
- Google Chrome（`/usr/bin/google-chrome`）を使う

拡張として読み込むのではなく、Chrome に `chrome.*` の代用オブジェクトと content.js を注入して動かす。次の 2 つの理由で、拡張をそのまま読み込む方法は使えない。

- Google Chrome 147 は `--load-extension` で拡張を読み込めない
- Playwright 同梱の Chromium は H.264 を再生できず、Twitch の映像が読み込まれない（readyState が 0 のまま）

## site_sim.py

```sh
# Twitch（視聴者数上位のライブ配信）で Auto-Gain を 30 秒動かす
python3 site_sim.py '{"autoGainEnabled": true, "showDebugInfo": true}' 30

# 10 秒目にホイールで音量を 3 段階上げ、16 秒目に一時停止、18 秒目に再生する
python3 site_sim.py '{"defaultVolume": 20}' 24 \
  '[[10, "wheel:-100:3"], [16, "click:[data-a-target=player-play-pause-button]"], [18, "click:[data-a-target=player-play-pause-button]"]]'

# YouTube（再生ボタンは .ytp-play-button）
URL='https://www.youtube.com/watch?v=dQw4w9WgXcQ' python3 site_sim.py '{"autoGainEnabled": true, "showDebugInfo": true}' 30
```

3 秒ごとに次の内容を出力する。

- `videos`：ページ内の各 video 要素の状態（`src`／`srcObject` の種類、`volume`、`readyState` など）
- `player`：YouTube の `getVolume()`、または Twitch の音量スライダーの値
- `dbg`：inject.js のデバッグ表示（OSD に出る `[webaudio v1.2.3] L:... G:...` と同じ文字列）。直近 3 件
- `report`：inject.js が content.js に報告した音量

操作の書き方と環境変数は、ファイル冒頭のコメントにある。

## 注意点

- **既定では自動再生の制限を外して動かす**（`--autoplay-policy=no-user-gesture-required`）。実機では、ページを一度も操作していないと AudioContext が止まったままになる（Auto-Gain は「Waiting for AudioContext (click the page)」で待機する）。この状況を確かめるときは `AUTOPLAY=strict` を付け、`URL=` で配信ページを直接開く。Twitch の一覧ページを経由すると、そこでの操作がページ移動の後まで引き継がれることがある。新しいプロファイルでは Twitch がミュートで自動再生するので、AudioContext が動いていれば表示は「Loop: Muted」になる
- Playwright の `page.evaluate` はユーザー操作として評価され、ページが「操作済み」になる。そのため、状態の読み取りや操作の JS 式は CDP の `Runtime.evaluate`（`userGesture: false`）で評価している。`page.evaluate` を足すと AudioContext の検証が狂う
- 実際の content script と違い、content.js も page context で動く。2 つのスクリプトは `window` の CustomEvent でやり取りするので、通信経路は拡張と同じになる
- YouTube はヘッドレスだと、拡張の有無に関係なく約 40 秒で「Something went wrong」になり再生が止まる（ボット判定）。それより長い挙動は実機で確かめる
- Twitch の動画は `srcObject = MediaSourceHandle`（Worker 内の MSE）で再生され、`src` は空になる

## measure_levels.js

同じ動画の音量を captureStream と MediaElementSource の両方で測り、dBFS で比べる。Auto-Gain の測定値がおかしいとき、測り方の問題か動画そのものが小さいのかを切り分けるのに使う。使い方はファイル冒頭のコメントにある。
