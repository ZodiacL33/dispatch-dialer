// Runs inside voice.google.com. Reads call state and presses Call after a deep-link dial.
(() => {
  const DEF = {
    endRe: '^(end call|hang up|end|call_end|call end)$',
    callRe: '^(call|start call)$',
    readyRe: 'calls|messages|voicemail',
  };
  const re = {};
  async function loadCfg() {
    let cfg = {};
    try { cfg = (await chrome.storage.local.get('cfg')).cfg || {}; } catch { return; }
    for (const k of Object.keys(DEF)) {
      try { re[k] = new RegExp(cfg[k] || DEF[k], 'i'); } catch { re[k] = new RegExp(DEF[k], 'i'); }
    }
  }
  const vis = (el) => el.offsetWidth > 0 || el.offsetHeight > 0;
  const label = (el) =>
    (el.getAttribute('aria-label') || el.getAttribute('mattooltip') || el.getAttribute('title') ||
      el.textContent || '').trim().replace(/\s+/g, ' ');
  function find(r) {
    for (const el of document.querySelectorAll('button,[role="button"],[role="tab"],[role="link"],a')) {
      if (!vis(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (r.test(label(el))) return el;
    }
    return null;
  }
  function state() {
    if (find(re.endRe)) return 'oncall';
    return find(re.readyRe) ? 'idle' : 'unknown';
  }

  async function handlePending() {
    let p;
    try { p = (await chrome.storage.local.get('pendingDial')).pendingDial; } catch { return; }
    if (!p) return;
    await chrome.storage.local.remove('pendingDial');
    if (Date.now() - p.ts > 30000 || p.dry) return;
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (Date.now() - t0 > 15000 || state() === 'oncall') return clearInterval(iv);
      // Safety: only press Call once the carrier's number is visibly loaded on the page.
      const inInput = [...document.querySelectorAll('input')].some(
        (i) => i.value.replace(/\D/g, '').endsWith(p.number));
      const inText = document.body.innerText.replace(/\D/g, '').includes(p.number);
      if (!inInput && !inText) return;
      const b = find(re.callRe);
      if (b) { clearInterval(iv); setTimeout(() => b.click(), 700); }
    }, 400);
  }

  chrome.runtime.onMessage.addListener((m, _s, send) => {
    if (m && m.type === 'GET_STATE') {
      loadCfg().then(() => send({ state: state() }));
      return true;
    }
  });
  loadCfg().then(handlePending);
})();
