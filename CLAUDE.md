# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

SmartGain：YouTube・Twitch などの動画の音量を Web Audio で自動調整し（Auto-Gain）、右クリック＋ホイールでの音量操作も提供する Chrome 拡張。Manifest V3・素の JS/HTML/CSS でビルドはない。**リポジトリ直下がそのまま拡張のフォルダ**で、Chrome の「パッケージ化されていない拡張機能を読み込む」で直接読み込める。MIT。

UI の文字サイズは最低 1.0rem にする（ユーザーの必須要望）。

## コマンド

```sh
# JS の構文チェック（ホストに node はないので使い捨てコンテナで）
docker run --rm -v "$PWD":/w -w /w node:24-alpine node --check <file>.js
```

- 単体テストはない。代わりに `test/site_sim.py`（ホストの python3 + Playwright + Google Chrome）で、実際の Twitch / YouTube に content.js と inject.js を注入して挙動を記録できる。使い方と制約は `test/README.md` にある。ユーザーに実機での確認を頼む前に、まずこれで確かめる

## アーキテクチャ

- **2 つの実行コンテキストに分かれている。**
  - `content.js`：content script（isolated world、全フレーム、`document_start`）。設定の読み込み（`chrome.storage.sync`）、ホイール操作、OSD 表示、デバッグログの保存を担う。起動時に `inject.js` を `<script>` としてページに注入する
  - `inject.js`：page context で動く。`movie_player` API、`HTMLMediaElement.prototype.volume` の setter フック（音量ロック）、Web Audio のグラフ（MediaElementSource → フィルター・測定用 Analyser → 正規化 Gain → コンプレッサー → メイクアップ Gain → リミッター → 出力 Gain）、ビジュアライザーを担う
- 2 つの間の通信は `window` 上の `CustomEvent` で、イベント名はすべて `YoutubeVolumeControl*`（Settings / Sync / Lock / CheckId / Report / Stats / Debug など）。新しいやり取りを足すときは両側に送信と受信の処理を書く
- 設定のデフォルト値は `content.js` の `this.settings` と `options.js` の `defaultSettings` に重複して定義されている。設定項目を足すときは両方と `options.html` を更新する
- 動画ごとの Auto-Gain の集計は `content.js` が `chrome.storage.local` の `dbg:<videoId>` に保存し（最大 50 件）、設定画面の「デバッグログ」で表示・コピーできる。不具合の調査ではまずこれを見る
- YouTube では `video.volume` ＝ プレイヤー音量 × 動画ごとの正規化係数になっている。`video.volume` を直接書き換えると係数が外れ、後で YouTube が掛け直したときに音量が急に下がる。音量の測定や補正では、この係数を割り戻して扱う
- Twitch の動画は `srcObject` が `MediaSourceHandle`（Worker 内の MSE）で `src` は空。Web Audio には通せる（`canRouteThroughWebAudio`）。Twitch は自分の音量（スライダー・localStorage の `volume`）を持ち、広告明けなどに video.volume へかけ直すので、拡張が音量を変えるときは Twitch 側も合わせる（`setTwitchPlayerVolume`）。ページ内遷移では yt-navigate のようなイベントがないので、URL の変化でラウドネスの推定をやり直す

## 配布

- 配布は Chrome ウェブストアではなく、vel.works の紹介ページ（https://vel.works/chrome_ext/smartgain/）からの zip。`python3 scripts/release.py [--publish]` で `dist/smartgain-<版>.zip` を作る（LICENSE は入れ、テスト・文書・スクリプトは入れない）。`--publish` で vel.works の紹介ページのフォルダ（`/var/docker/docker-shared/dev-server-php8/vel.works/chrome_ext/smartgain/`）に置き、古い zip を消す
- 版を上げるときに直すもの: `manifest.json` の `version`（`inject.js` の `AGC_VERSION` も。release.py が照合する）、`CHANGELOG.md`、vel.works の紹介ページ（`<!-- download:start -->` と `<!-- changelog:start -->` の欄）と `vel.works/_build/data/catalog.json` の version。そのあと vel.works をビルドして `chrome_ext` と `top` を本番へ反映する（手順は `dev-server-php8/CLAUDE.md`）。git では `v<版>` のタグを付けて push する
- **manifest の `key` を消したり変えたりしない。** 拡張 ID を固定する公開鍵で、変わると利用者の保存データが消える。対応する秘密鍵はリポジトリの外（`~/.config/velworks/chromeext-keys/`）にあり、ウェブストアに出すときだけ使う
- 公開リポジトリ（GitHub）。コミットの前に、追跡対象に個人情報（実データ、個人のメールアドレスなど）が入っていないか確かめる（開発サーバー上のパスは作業に必要なので可。ホスト名・IP アドレス・認証情報は不可）。作者は `velstau <velstau@users.noreply.github.com>`（リポジトリの設定）
