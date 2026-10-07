# 動画のないフレームに OSD が出ないことを確かめる
#
# content script は全フレームで動き、inject.js の状態報告 (Debug) はどのフレームでも届く。
# YouTube のライブチャットのような「動画のない iframe」で OSD がフレームの右上に出ていた不具合の確認用。
# 動画のある最上位フレームと、動画のない iframe からなるページ (www.youtube.com に見せかけたローカルの HTML) で、
# 各フレームの OSD の有無を出力する。
#
# 使い方: python3 osd_frames.py
import asyncio, json, os, re
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.environ.get('EXT', os.path.join(HERE, '..'))
SETTINGS = {'defaultVolume': 5}  # 既定の設定 (OSD あり・デバッグ表示なし)

# site_sim.py の STUB から「最上位フレームだけ」の制限を外したもの (iframe でも content.js を動かす)
STUB = open(os.path.join(HERE, 'site_sim.py'), encoding='utf-8').read()
STUB = re.search(r'STUB = """(.*?)"""', STUB, re.S).group(1)
STUB = STUB.replace("  if (window.top !== window) return; // 最上位フレームだけで動かす\n", '')

PAGE = """<!doctype html><body style="margin:0">
<div style="display:flex"><div style="width:640px;height:360px;position:relative"><video style="width:100%;height:100%"></video></div>
<iframe src="/chat" style="width:300px;height:360px"></iframe></div></body>"""
CHAT = '<!doctype html><body><p>chat</p></body>'


async def main():
    content = open(os.path.join(EXT, 'content.js'), encoding='utf-8').read()
    inject = open(os.path.join(EXT, 'inject.js'), encoding='utf-8').read()
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context()
        await ctx.add_init_script(STUB % (json.dumps(SETTINGS), content))

        async def route(r):
            url = r.request.url
            if url.startswith('https://smartgain.sim/'):
                await r.fulfill(body=inject, content_type='text/javascript')
            elif url.endswith('/chat'):
                await r.fulfill(body=CHAT, content_type='text/html')
            else:
                await r.fulfill(body=PAGE, content_type='text/html')
        await ctx.route('**/*', route)

        page = await ctx.new_page()
        await page.goto('https://www.youtube.com/')
        await page.wait_for_timeout(1500)
        for f in page.frames:
            osd = await f.evaluate("""() => {
              const o = document.getElementById('yt-vol-control-display');
              return o ? { display: o.style.display, parent: o.parentElement.tagName, text: o.innerText.slice(0, 40) } : null;
            }""")
            print('top   ' if f == page.main_frame else 'iframe', f.url, json.dumps(osd, ensure_ascii=False))
        await browser.close()

asyncio.run(main())
