// 同じ動画の音量を captureStream と MediaElementSource の両方で測って比べる (dBFS)
// Auto-Gain の測定値がおかしいとき、測り方の問題か、動画そのものが小さいのかを切り分けるために使う。
// MediaElementSource を作るとその動画は以後 Web Audio 経由になるので、拡張を無効 ({"featureEnabled": false}) にして使う。
// 使い方 (test/ で実行):
//   python3 site_sim.py '{"featureEnabled": false}' 5 "$(python3 -c "import json;print(json.dumps([[4, open('measure_levels.js').read()]]))")"
async () => {
  const v = document.querySelector('video');
  const ctx = new AudioContext();
  await ctx.resume();
  const mk = () => { const a = ctx.createAnalyser(); a.fftSize = 4096; return a; };
  const rms = (a) => { const b = new Float32Array(a.fftSize); a.getFloatTimeDomainData(b); let s = 0; for (const x of b) s += x * x; return s / b.length; };
  const db = (e) => (10 * Math.log10(e)).toFixed(1);
  const r = { vol: v.volume, srcObject: v.srcObject && v.srcObject.constructor.name, state: ctx.state };
  // 1) captureStream
  const st = v.captureStream();
  r.tracks = st.getAudioTracks().map(t => [t.label, t.readyState, t.enabled, t.muted, JSON.stringify(t.getSettings())]);
  const aCap = mk(); ctx.createMediaStreamSource(st).connect(aCap);
  let eCap = 0; for (let i = 0; i < 20; i++) { await new Promise(res => setTimeout(res, 100)); eCap += rms(aCap); }
  r.capture_dBFS = db(eCap / 20);
  // 2) MediaElementSource (同じ動画)
  try {
    const src = ctx.createMediaElementSource(v); const aEl = mk(); src.connect(aEl); src.connect(ctx.destination);
    let eEl = 0; for (let i = 0; i < 20; i++) { await new Promise(res => setTimeout(res, 100)); eEl += rms(aEl); }
    r.element_dBFS = db(eEl / 20);
    // captureStream を同時にもう一度
    eCap = 0; for (let i = 0; i < 20; i++) { await new Promise(res => setTimeout(res, 100)); eCap += rms(aCap); }
    r.capture2_dBFS = db(eCap / 20);
    r.element_vol1 = (() => { v.volume = 1; return 'set'; })();
    await new Promise(res => setTimeout(res, 300));
    let e3 = 0, e4 = 0; for (let i = 0; i < 20; i++) { await new Promise(res => setTimeout(res, 100)); e3 += rms(aEl); e4 += rms(aCap); }
    r.element_at_vol1_dBFS = db(e3 / 20); r.capture_at_vol1_dBFS = db(e4 / 20);
  } catch (e) { r.elementErr = e.message; }
  return r;
}
