/** 临时：抓页面 console / 异常，定位 boot 失败原因 */
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.argv[2] || 9666);
const CDP = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { spawn } = await import('node:child_process');

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-proxy-server', '--no-sandbox',
  '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--window-size=1280,800',
  `--user-data-dir=/tmp/chrome-dbg-${PORT}`, 'about:blank',
], { stdio: 'ignore' });

for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1000) }); if (r.ok) break; } catch {}
  await sleep(500);
}
const ver = await (await fetch(`${CDP}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pend = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { const { r, j } = pend.get(m.id); pend.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); }
  else if (m.method) logs.push(m);
};
const send = (method, params = {}) => new Promise((r, j) => { const mid = ++id; pend.set(mid, { r, j }); ws.send(JSON.stringify({ id: mid, method, params })); });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (method, params = {}) => new Promise((r, j) => { const mid = ++id; pend.set(mid, { r, j }); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); });

await S('Runtime.enable');
await S('Log.enable');
await S('Page.enable');
await S('Runtime.addBinding', { name: '__dbg' }).catch(() => {});
await S('Page.navigate', { url: 'http://127.0.0.1:5173/' });
await sleep(Number(process.argv[3] || 25000));

const ev = (await S('Runtime.evaluate', {
  expression: `(() => {
    const o = document.getElementById('overlay');
    return JSON.stringify({
      url: location.href,
      ready: document.readyState,
      bodyLen: document.body ? document.body.innerHTML.length : -1,
      overlayShown: o ? o.classList.contains('show') : null,
      overlayText: document.getElementById('overlay-text')?.textContent,
      hasGarage: typeof window.__garage,
      keys: window.__garage ? Object.keys(window.__garage) : [],
      brand: !!document.querySelector('.jg-brand--sidebar'),
    });
  })()`,
  returnByValue: true,
})).result?.value;
console.log('页面状态:', ev);

console.log('\n── 控制台 ──');
for (const m of logs) {
  if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    console.log(`  [${e.level}] ${e.text} ${e.url || ''}:${e.lineNumber || 0}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    console.log(`  [exception] ${d.exception?.description || d.text}`);
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const a = (m.params.args || []).map((x) => x.value ?? x.description ?? x.type).join(' ');
    console.log(`  [console.${m.params.type}] ${a}`);
  }
}

ws.close();
chrome.kill();
process.exit(0);
