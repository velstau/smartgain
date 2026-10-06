# SmartGain を実サイト (Twitch / YouTube) で動かして挙動を記録する
#
# Google Chrome 147 は --load-extension で拡張を読み込めず、Playwright 同梱 Chromium は H.264 を再生できない
# (Twitch が映らない)。そこで Google Chrome に chrome.* の代用オブジェクトと content.js を注入し、
# inject.js は ctx.route で配信して、拡張とほぼ同じ構成で動かす。
#
# 使い方: python3 site_sim.py '<設定 JSON>' <秒数> ['<操作 JSON>']
#   設定:  chrome.storage.sync の初期値 (例: {"autoGainEnabled": true, "showDebugInfo": true})
#   操作:  [[秒, "操作"], ...]。操作は次のいずれか
#            "wheel:<deltaY>:<回数>"  動画の上で右ボタンを押したままホイール (deltaY < 0 で音量アップ)
#            "click:<セレクタ>"       実際のマウスクリック
#            "reload"                 ページを読み込み直す (拡張の注入はそのまま効く)
#            それ以外                 JS の関数式 ("() => ...") を評価して結果を表示する
#   環境変数: URL=<開くページ> (省略時は Twitch の視聴者数上位のライブ配信)
#             SHOT=<終了時のスクリーンショットの保存先>
#             AUTOPLAY=strict  自動再生の制限を外さない (既定では外す。外さないとユーザー操作まで AudioContext が止まる)
#             SOUND_ALLOW=<origin,...>  Chrome のサイト設定「音声」を「許可」にしたプロファイルで起動する
#                                       (例: https://www.twitch.tv:443)
import asyncio, json, os, sys, tempfile
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.environ.get('EXT', os.path.join(HERE, '..'))
SETTINGS = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
DURATION = int(sys.argv[2]) if len(sys.argv) > 2 else 30
ACTIONS = json.loads(sys.argv[3]) if len(sys.argv) > 3 else []
URL = os.environ.get('URL')

# chrome.storage / chrome.runtime の代用。実際の content script と違い page context で動くが、
# content.js と inject.js は window の CustomEvent でやり取りするので通信経路は同じになる
STUB = """
(() => {
  if (window.top !== window) return; // 最上位フレームだけで動かす
  const store = { sync: %s, local: {} };
  const listeners = [];
  const area = (name) => ({
    get(keys, cb) {
      let r;
      if (keys === null) r = { ...store[name] };
      else if (typeof keys === 'object' && !Array.isArray(keys)) { r = { ...keys }; for (const k in keys) if (k in store[name]) r[k] = store[name][k]; }
      else r = {};
      setTimeout(() => cb && cb(r), 0);
    },
    set(obj, cb) {
      const changes = {};
      for (const k in obj) { changes[k] = { oldValue: store[name][k], newValue: obj[k] }; store[name][k] = obj[k]; }
      setTimeout(() => { listeners.forEach((l) => l(changes, name)); cb && cb(); }, 0);
    },
    remove(keys, cb) { [].concat(keys).forEach((k) => delete store[name][k]); cb && cb(); },
  });
  const chrome = {
    runtime: { id: 'sim', lastError: undefined, getURL: (p) => 'https://smartgain.sim/' + p, getManifest: () => ({}) },
    storage: { sync: area('sync'), local: area('local'), onChanged: { addListener: (l) => listeners.push(l) } },
  };
  window.__sgSetSync = (obj) => chrome.storage.sync.set(obj); // 実行中に設定を変える: 操作の JS 式から呼ぶ
  const run = () => { %s };
  // 実際の document_start では documentElement がある。init script の時点では無いことがあるので待つ
  // (待たないと content.js の例外が safeCallback に握りつぶされ、inject.js が注入されない)
  if (document.documentElement) run();
  else { const mo = new MutationObserver(() => { if (document.documentElement) { mo.disconnect(); run(); } }); mo.observe(document, { childList: true }); }
})();
"""

# inject.js が出すデバッグ表示 (OSD の [...] と同じ文字列) と音量報告を記録する
RECORDER = """window.__dbg = []; window.__rep = [];
  addEventListener('YoutubeVolumeControlDebug', e => __dbg.push([Math.round(performance.now()), e.detail]));
  addEventListener('YoutubeVolumeControlReport', e => __rep.push([Math.round(performance.now()), e.detail]));"""

STATE_JS = """() => [...document.querySelectorAll('video')].map(v => ({
  src: (v.currentSrc || v.src || '').slice(0, 40), srcObject: v.srcObject ? v.srcObject.constructor.name : null,
  paused: v.paused, muted: v.muted, vol: Math.round(v.volume * 1000) / 1000, rs: v.readyState, w: v.clientWidth,
}))"""
PLAYER_JS = """() => {
  const yt = document.getElementById('movie_player');
  if (yt && yt.getVolume) return { ytVolume: yt.getVolume() };
  const s = document.querySelector('[data-a-target="player-volume-slider"]');
  return s ? { twitchSlider: s.value } : {};
}"""


async def evaluate(cdp, fn):
    # page.evaluate はユーザー操作扱い (userGesture: true) で評価され、ページに操作済みの印 (sticky activation) が付く。
    # すると「操作されるまで AudioContext が始まらない」状況を再現できないので、CDP で userGesture: false にして評価する
    r = await cdp.send('Runtime.evaluate', {'expression': f'({fn})()', 'returnByValue': True, 'awaitPromise': True, 'userGesture': False})
    if 'exceptionDetails' in r:
        return 'ERROR: ' + r['exceptionDetails'].get('exception', {}).get('description', r['exceptionDetails'].get('text', ''))[:200]
    return r['result'].get('value')


async def right_wheel(ctx, page, dy, n):
    # Playwright の mouse.wheel ではボタン押下状態が乗らない (buttons=0) ので CDP で buttons=2 を付けて送る
    box = await page.locator('video').first.bounding_box()
    x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    cdp = await ctx.new_cdp_session(page)
    ev = lambda **k: cdp.send('Input.dispatchMouseEvent', {'x': x, 'y': y, **k})
    await ev(type='mouseMoved')
    await ev(type='mousePressed', button='right', buttons=2, clickCount=1)
    for _ in range(n):
        await ev(type='mouseWheel', deltaX=0, deltaY=dy, buttons=2)
        await page.wait_for_timeout(60)
    await ev(type='mouseReleased', button='right', buttons=0, clickCount=1)
    # Escape でコンテキストメニューを閉じたりはしない (キー入力がユーザー操作になり AudioContext の検証を狂わせる)


async def main():
    content = open(os.path.join(EXT, 'content.js'), encoding='utf-8').read()
    inject = open(os.path.join(EXT, 'inject.js'), encoding='utf-8').read()
    profile = tempfile.mkdtemp()
    if os.environ.get('SOUND_ALLOW'):
        os.makedirs(os.path.join(profile, 'Default'))
        exceptions = {f'{o},*': {'setting': 1} for o in os.environ['SOUND_ALLOW'].split(',')}  # 1 = 許可
        with open(os.path.join(profile, 'Default', 'Preferences'), 'w') as f:
            json.dump({'profile': {'content_settings': {'exceptions': {'sound': exceptions}}}}, f)
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            profile, channel='chrome', headless=True, bypass_csp=True,
            args=[] if os.environ.get('AUTOPLAY') == 'strict' else ['--autoplay-policy=no-user-gesture-required'],
            viewport={'width': 1400, 'height': 900})
        await ctx.route('https://smartgain.sim/**', lambda r: r.fulfill(body=inject, content_type='text/javascript'))
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        page.on('console', lambda m: print('[console]', m.text[:160]) if ('SmartGain' in m.text or 'Volume Control' in m.text or 'AudioContext' in m.text) else None)
        page.on('pageerror', lambda e: print('[pageerror]', str(e)[:200]))
        await page.add_init_script(RECORDER)
        await page.add_init_script(STUB % (json.dumps(SETTINGS), content))

        url = URL
        if not url:
            await page.goto('https://www.twitch.tv/directory/all', wait_until='domcontentloaded')
            await page.wait_for_selector('a[data-a-target="preview-card-image-link"]', timeout=30000)
            url = await page.eval_on_selector('a[data-a-target="preview-card-image-link"]', 'a => a.href')
        print('url', url)
        await page.goto(url, wait_until='domcontentloaded')
        cdp = await ctx.new_cdp_session(page)

        actions = sorted(ACTIONS)
        for t in range(1, DURATION + 1):
            await page.wait_for_timeout(1000)
            while actions and actions[0][0] <= t:
                op = actions.pop(0)[1]
                if op.startswith('wheel:'):
                    _, dy, n = op.split(':')
                    await right_wheel(ctx, page, int(dy), int(n))
                    print(f'>>> t={t}s {op} -> video.volume', await evaluate(cdp, "() => document.querySelector('video').volume"))
                elif op == 'reload':
                    await page.reload(wait_until='domcontentloaded')
                    cdp = await ctx.new_cdp_session(page)
                    print(f'>>> t={t}s reload')
                elif op.startswith('click:'):
                    await page.click(op[len('click:'):])
                    print(f'>>> t={t}s {op}')
                else:
                    print(f'>>> t={t}s {op} ->', await evaluate(cdp, op))
            if t % 3 == 0 or t == DURATION:
                st = await evaluate(cdp, STATE_JS)
                pl = await evaluate(cdp, PLAYER_JS)
                dbg = await evaluate(cdp, '() => __dbg.splice(0)')
                rep = await evaluate(cdp, '() => __rep.splice(0)')
                print(f'--- t={t}s videos={json.dumps(st)} player={pl}')
                for d in dbg[-3:]:
                    print('    dbg', d)
                if rep:
                    print('    report', sorted(set(r[1] for r in rep)))
        await page.screenshot(path=os.environ.get('SHOT', 'site_sim.png'))
        await ctx.close()

asyncio.run(main())
