const $ = (id) => document.getElementById(id);
const LOWER48 = new Set(('AL AR AZ CA CO CT DE FL GA IA ID IL IN KS KY LA MA MD ME MI MN MO MS MT ' +
  'NC ND NE NH NJ NM NV NY OH OK OR PA RI SC SD TN TX UT VA VT WA WI WV WY').split(' '));
const PHONE_OK = /^[2-9]\d{9}$/;
const DEF = {
  maxFleet: 30, minFleet: 0, blockSize: 10000, dailyGoal: 0, autoDial: false, delaySec: 10,
  dryRun: false, liveCheck: false, webKey: '',
  endRe: '^(end call|hang up|end|call_end|call end)$',
  callRe: '^(call|start call)$',
  readyRe: 'calls|messages|voicemail',
};
const TYPES = { lead: 'Lead', sale: 'Sale', followup: 'Follow-up', dnc: 'Do not call' };
// phase: empty | ready | dialing | oncall | wrapup | done
const S = { queue: [], map: {}, idx: 0, calls: {}, leads: {}, notes: {}, run: 1, cfg: { ...DEF },
  cur: null, parked: null, isManual: false, phase: 'empty', gv: 'unknown', paused: false,
  idle: 0, lost: 0, timer: null, dog: null, left: 0, msg: '', busy: false, polling: false,
  bkey: '', bleft: 0, shown: '' };

// ---------- helpers ----------
const fmtPhone = (p) => (p && p.length === 10 ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p || '');
const todayISO = () => new Date().toLocaleDateString('en-CA');
const blockOf = (mc) => { const z = Number(S.cfg.blockSize) || 10000; return Math.floor(Number(mc) / z) * z; };
const timeout = (p, ms, fb) => Promise.race([p, new Promise((r) => setTimeout(() => r(fb), ms))]);
const carrierOf = (mc) => S.map[mc] || (S.leads[mc] && S.leads[mc].carrier) || { mc };
const ckey = () => `${S.run}:${S.cur.mc}${S.isManual ? ':m' : ''}`;
const safe = (fn) => async (...a) => {
  try { return await fn(...a); }
  catch (e) { S.busy = false; S.msg = `Something went wrong (${(e && e.message) || e}). The panel is still running.`; try { render(); } catch {} }
};
window.addEventListener('error', (e) => { S.busy = false; S.msg = 'A small error happened and was ignored: ' + e.message; try { render(); } catch {} });
window.addEventListener('unhandledrejection', (e) => { S.busy = false; S.msg = 'A small error happened and was ignored.'; e.preventDefault(); try { render(); } catch {} });

let saveT = null;
async function save() {
  clearTimeout(saveT);
  try {
    await chrome.storage.local.set({ cfg: S.cfg, idx: S.idx, calls: S.calls, leads: S.leads, notes: S.notes,
      run: S.run, curMc: S.cur && !S.isManual ? S.cur.mc : null });
  } catch (e) { S.msg = 'Could not save to disk: ' + e.message; }
}
const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(save, 500); };

// ---------- queue ----------
function setQueue(q) {
  S.queue = Array.isArray(q)
    ? q.filter((c) => c && c.mc && PHONE_OK.test(c.phone || '')).sort((a, b) => Number(a.mc) - Number(b.mc)) : [];
  S.map = Object.fromEntries(S.queue.map((c) => [c.mc, c]));
}

function eligible(c) {
  if (!c || !c.mc || S.leads[c.mc] || S.calls[`${S.run}:${c.mc}`]) return false;
  if (!PHONE_OK.test(c.phone || '') || !LOWER48.has(c.state)) return false;
  const u = Number(c.units);
  return Number.isFinite(u) && u >= S.cfg.minFleet && u <= S.cfg.maxFleet;
}

function nextCarrier() {
  S.isManual = false;
  if (S.parked) { S.cur = S.parked; S.parked = null; S.phase = 'ready'; save(); return; }
  S.cur = null;
  while (S.idx < S.queue.length) {
    const c = S.queue[S.idx++];
    if (eligible(c)) { S.cur = c; break; }
  }
  S.phase = S.queue.length ? (S.cur ? 'ready' : 'done') : (S.leads && Object.keys(S.leads).length ? 'done' : 'empty');
  save();
}

async function loadFile(file) {
  if (!file) return;
  try {
    const q = JSON.parse(await file.text());
    if (!Array.isArray(q) || !q.length || !q[0].mc) throw new Error('not a queue file');
    setQueue(q);
    S.idx = 0; S.paused = false; S.parked = null;
    await chrome.storage.local.set({ queue: S.queue });
    nextCarrier();
    S.msg = `Loaded ${S.queue.length.toLocaleString()} carriers. Your history and saved carriers were kept.`;
  } catch {
    S.msg = 'That file is not a valid queue.json. Run build_queue.py and try again.';
  }
  render(); renderStats();
}

// ---------- Google Voice link ----------
const voiceTab = async () => (await chrome.tabs.query({ url: 'https://voice.google.com/*' }))[0] || null;
async function askState(tab) {
  try { return (await timeout(chrome.tabs.sendMessage(tab.id, { type: 'GET_STATE' }), 2500, null)).state || 'unknown'; }
  catch { return 'unknown'; }
}

async function poll() {
  if (S.polling) return;
  S.polling = true;
  try {
    const tab = await timeout(voiceTab(), 2500, null);
    S.gv = tab ? await askState(tab) : 'nogv';
    S.idle = S.gv === 'idle' ? S.idle + 1 : 0;
    if (S.phase === 'dialing' && S.gv === 'oncall') { clearTimeout(S.dog); S.phase = 'oncall'; S.lost = 0; }
    else if (S.phase === 'oncall') {
      if (S.gv === 'oncall') S.lost = 0;
      else if (S.idle >= 2) endCall();                 // idle twice in a row = you hung up
      else if (++S.lost >= 10) { endCall(); S.msg = 'Lost sight of Google Voice, so the call was treated as ended.'; }
    }
  } catch { /* keep running */ }
  S.polling = false;
  render();
}

function setCall(status) {
  const k = ckey();
  const o = S.calls[k] || { mc: S.cur.mc, run: S.run, manual: S.isManual, ts: Date.now() };
  o.status = status; S.calls[k] = o;
}

function endCall() {
  if (S.cur && !S.calls[ckey()]) setCall('called');
  S.phase = 'wrapup';
  save(); renderStats();
  if (S.cfg.autoDial && !S.paused) countdown(Math.max(3, Number(S.cfg.delaySec) || 10));
}

function countdown(sec) {
  clearInterval(S.timer);
  S.left = sec;
  S.timer = setInterval(() => {
    if (S.paused || S.phase !== 'wrapup' || !S.cfg.autoDial) { clearInterval(S.timer); S.left = 0; render(); return; }
    if (--S.left <= 0) { clearInterval(S.timer); S.left = 0; safe(go)(); }
    render();
  }, 1000);
}

function fail(msg) {
  clearTimeout(S.dog); clearInterval(S.timer); S.left = 0;
  S.msg = msg; S.busy = false;
  if (S.phase === 'dialing') S.phase = 'ready';
  if (S.cfg.autoDial) { S.paused = true; S.msg += ' Auto-dial paused.'; }
  render();
}

async function liveCheck(c) {
  if (!S.cfg.liveCheck || !S.cfg.webKey || !c.dot) return { ok: null };
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(`https://mobile.fmcsa.dot.gov/qc/services/carriers/${encodeURIComponent(c.dot)}?webKey=${encodeURIComponent(S.cfg.webKey)}`, { signal: ctl.signal });
    if (!r.ok) return { ok: null };
    const j = await r.json();
    const k = (j && j.content && (j.content.carrier || j.content)) || {};
    const com = k.commonAuthorityStatus, con = k.contractAuthorityStatus;
    if (com === undefined && con === undefined && k.allowedToOperate === undefined) return { ok: null };
    if (k.allowedToOperate === 'N') return { ok: false, reason: 'FMCSA says it is not allowed to operate' };
    if (com !== 'A' && con !== 'A') return { ok: false, reason: 'its authority is not active' };
    if (k.brokerAuthorityStatus === 'A') return { ok: false, reason: 'it also has broker authority' };
    return { ok: true };
  } catch { return { ok: null }; }
  finally { clearTimeout(t); }
}

async function go() {                       // advance if needed, then dial
  if (S.busy) return;
  if (S.phase === 'wrapup') nextCarrier();
  if (!S.cur) return render();
  await dial();
}

async function dial() {
  const c = S.cur;
  if (!c || S.busy) return;
  if (S.phase === 'dialing' || S.phase === 'oncall') return fail('A call is already in progress. Not dialing.');
  S.busy = true; S.msg = '';
  const tab = await timeout(voiceTab(), 2500, null);
  if (!tab) return fail('Open voice.google.com in a Chrome tab and sign in first.');
  const st = await askState(tab);             // fresh check right before dialing
  if (st === 'oncall') return fail('You are on a call. Not dialing.');
  if (st !== 'idle') return fail('Cannot read Google Voice yet (still loading, or button names changed). Not dialing.');
  if (!PHONE_OK.test(c.phone)) return fail('This number is not a valid US number. Skipped.');
  if (!S.isManual) {
    const v = await liveCheck(c);
    if (v.ok === false) {
      if (!S.calls[ckey()]) setCall('skipped');
      S.busy = false; nextCarrier();
      S.msg = `Skipped ${c.name}: live check says ${v.reason}.`;
      render(); renderStats();
      if (S.cfg.autoDial && !S.paused && S.cur) return go();
      return;
    }
    if (v.ok === null && S.cfg.liveCheck) S.msg = 'Live check could not run, so this one was dialed without it.';
  }
  await chrome.storage.local.set({ pendingDial: { number: c.phone, ts: Date.now(), dry: S.cfg.dryRun } });
  S.phase = 'dialing';
  S.dog = setTimeout(() => { if (S.phase === 'dialing') fail(S.cfg.dryRun
    ? 'Test mode: number loaded, Call was not pressed.'
    : 'Could not confirm the call started. Check the Google Voice tab.'); }, S.cfg.dryRun ? 60000 : 25000);
  if (S.cfg.dryRun) S.msg = 'Test mode: number loaded. Press Call yourself.';
  try {
    await chrome.tabs.update(tab.id, { url: `https://voice.google.com/u/0/calls?a=nc,%2B1${c.phone}` });
  } catch { return fail('Could not open the Google Voice tab.'); }
  S.busy = false;
  render();
}

// ---------- actions ----------
function outcome(status) {
  if (!S.cur) return;
  setCall(status);
  if (status === 'dnc') saveLead('dnc', '');
  if (S.phase === 'ready' && !S.isManual) nextCarrier();
  save(); render(); renderStats(); renderSaved();
}

function skip() {
  if (!S.cur || S.phase === 'dialing' || S.phase === 'oncall') return;
  if (!S.isManual && !S.calls[ckey()]) setCall('skipped');
  clearInterval(S.timer); S.left = 0;
  nextCarrier(); render(); renderStats();
}

function togglePause() {
  S.paused = !S.paused;
  if (S.paused) { clearInterval(S.timer); S.left = 0; }
  else if (S.cfg.autoDial && S.phase === 'wrapup') countdown(3);
  render();
}

function saveLead(type, date) {
  const c = S.cur; if (!c) return;
  const prev = S.leads[c.mc] || {};
  const d = date === undefined ? ($('followDate').value || prev.followDate || '') : date;
  S.leads[c.mc] = { type, followDate: d, ts: prev.ts || Date.now(), carrier: c };
  save(); render(); renderSaved();
}

function unsave() {
  if (!S.cur) return;
  delete S.leads[S.cur.mc];
  S.msg = 'Removed from saved. It can be dialed automatically again.';
  save(); render(); renderSaved();
}

async function openCarrier(c, dialNow) {
  if (S.phase === 'dialing' || S.phase === 'oncall') { S.msg = 'Finish the current call first.'; return render(); }
  if (S.cur && S.phase === 'ready' && !S.isManual) S.parked = S.cur;
  clearInterval(S.timer); S.left = 0;
  S.cur = c; S.isManual = true; S.phase = 'ready';
  save(); render();
  if (dialNow) await go();
}

function jump() {
  const v = Number($('jumpMc').value);
  if (!Number.isInteger(v) || v <= 0) { S.msg = 'Enter an MC number, for example 1300000.'; return render(); }
  if (S.phase === 'dialing' || S.phase === 'oncall') { S.msg = 'Finish the current call first.'; return render(); }
  if (!S.queue.length) { S.msg = 'Load queue.json first (see Settings), then jump to an MC.'; return render(); }
  const i = S.queue.findIndex((c) => Number(c.mc) >= v);
  if (i < 0) { S.msg = `No qualifying carriers at or after MC ${v}. That number may be higher than the newest MC in FMCSA's data. Try a lower one.`; return render(); }
  const b = blockOf(v);
  const repeat = Object.values(S.calls).some((l) => l.run === S.run && !l.manual && blockOf(l.mc) === b);
  if (repeat) S.run++;
  S.parked = null; clearInterval(S.timer); S.left = 0;
  S.idx = i; nextCarrier();
  S.msg = (S.cur ? `Jumped to MC ${S.cur.mc}.` : 'No eligible carriers from that MC on.') + (repeat ? ` Repeating this block: starting pass ${S.run}.` : '');
  render(); renderStats();
}

function infoText(c) {
  return [
    c.name + (c.dba ? ` (DBA ${c.dba})` : ''),
    `MC ${c.mc} | DOT ${c.dot}`,
    `Phone: ${fmtPhone(c.phone)}`,
    c.email && `Email: ${c.email}`,
    c.owner && `Owner/Officer: ${c.owner}`,
    `Fleet: ${c.units} trucks, ${c.drivers ?? '?'} drivers`,
    `Address: ${[c.street, c.city, c.state, c.zip].filter(Boolean).join(', ')}`,
    S.notes[c.mc] && `Note: ${S.notes[c.mc]}`,
  ].filter(Boolean).join('\n');
}

async function copyInfo() {
  if (!S.cur) return;
  try { await navigator.clipboard.writeText(infoText(S.cur)); S.msg = 'Copied.'; }
  catch { S.msg = 'Copy failed. Click inside the panel and try again.'; }
  render();
}

// ---------- exports ----------
const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
function download(name, lines) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
  a.download = `${name}-${todayISO()}.csv`; a.click();
}
function exportCalls() {
  const cols = ['status', 'called_at', 'pass', 'manual', 'mc', 'dot', 'name', 'phone', 'email', 'owner', 'city', 'state', 'units', 'drivers', 'note'];
  const rows = Object.values(S.calls).sort((a, b) => a.ts - b.ts).map((l) => { const c = carrierOf(l.mc);
    return [l.status, new Date(l.ts).toLocaleString(), l.run, l.manual ? 'yes' : '', l.mc, c.dot, c.name, c.phone, c.email, c.owner, c.city, c.state, c.units, c.drivers, S.notes[l.mc]].map(q).join(','); });
  download('call-log', [cols.join(','), ...rows]);
}
function exportSaved() {
  const cols = ['type', 'follow_up_date', 'mc', 'dot', 'name', 'phone', 'email', 'owner', 'city', 'state', 'note', 'saved_at'];
  const rows = Object.entries(S.leads).map(([mc, l]) => { const c = l.carrier || {};
    return [TYPES[l.type], l.followDate, mc, c.dot, c.name, c.phone, c.email, c.owner, c.city, c.state, S.notes[mc], new Date(l.ts).toLocaleString()].map(q).join(','); });
  download('saved-carriers', [cols.join(','), ...rows]);
}

// ---------- stats ----------
const PICKED = new Set(['interested', 'callback', 'notinterested', 'dnc']);
function stats() {
  const B = {};
  for (const l of Object.values(S.calls)) {
    if (l.status === 'skipped' || l.manual) continue;
    const b = blockOf(l.mc), k = `${b}|${l.run}`;
    const o = B[k] || (B[k] = { block: b, run: l.run, first: l.ts, last: 0, called: 0, picked: 0, interested: 0, callback: 0, unmarked: 0 });
    o.called++; o.last = Math.max(o.last, Number(l.mc)); o.first = Math.min(o.first, l.ts);
    if (PICKED.has(l.status)) o.picked++;
    if (l.status === 'interested') o.interested++;
    else if (l.status === 'callback') o.callback++;
    else if (l.status === 'called') o.unmarked++;
  }
  return Object.values(B).sort((a, b) => a.block - b.block || a.run - b.run);
}
const pct = (n, d) => (d ? Math.round((n / d) * 100) + '%' : '-');

function renderStats() {
  $('bs').textContent = S.cfg.blockSize;
  const t = $('stats'); t.textContent = '';
  const head = t.insertRow();
  for (const h of ['Block', 'Called', 'Picked up', 'Interested', 'Call back', 'Unmarked']) {
    const th = document.createElement('th'); th.textContent = h; head.append(th);
  }
  const rows = stats();
  for (const o of rows) {
    const marked = o.called - o.unmarked, r = t.insertRow();
    [null, o.called, `${o.picked} (${pct(o.picked, marked)})`, `${o.interested} (${pct(o.interested, marked)})`,
      `${o.callback} (${pct(o.callback, marked)})`, o.unmarked].forEach((v, i) => {
      const td = r.insertCell();
      if (i === 0) {
        td.textContent = String(o.block);
        const sm = document.createElement('small');
        sm.textContent = `pass ${o.run}, ${new Date(o.first).toLocaleDateString()}, to MC ${o.last}`;
        td.append(sm);
      } else td.textContent = v;
    });
  }
  if (!rows.length) { const td = t.insertRow().insertCell(); td.colSpan = 6; td.textContent = 'No calls recorded yet.'; }
}

function exportStats() {
  const cols = ['block_start', 'pass', 'first_call', 'last_mc_called', 'called', 'picked_up', 'pickup_rate', 'interested', 'callback', 'unmarked'];
  const rows = stats().map((o) => { const m = o.called - o.unmarked;
    return [o.block, o.run, new Date(o.first).toLocaleDateString(), o.last, o.called, o.picked, pct(o.picked, m), o.interested, o.callback, o.unmarked].map(q).join(','); });
  download('mc-block-stats', [cols.join(','), ...rows]);
}

// ---------- saved carriers list ----------
const isDue = (l) => l.type === 'followup' && l.followDate && l.followDate <= todayISO();
function renderSaved() {
  const f = $('savedFilter').value, ul = $('savedList');
  ul.textContent = '';
  const all = Object.entries(S.leads);
  $('savedCount').textContent = all.length;
  const items = all.filter(([, l]) => f === 'all' || l.type === f)
    .sort(([, a], [, b]) => (isDue(b) - isDue(a)) || String(a.followDate || '9').localeCompare(String(b.followDate || '9')) || b.ts - a.ts);
  if (!items.length) { const li = document.createElement('li'); li.textContent = 'Nothing saved here yet.'; ul.append(li); return; }
  for (const [mc, l] of items) {
    const c = l.carrier || { mc }, li = document.createElement('li');
    const b = document.createElement('strong'); b.textContent = c.name || `MC ${mc}`;
    const d = document.createElement('div');
    d.textContent = `${fmtPhone(c.phone)}  |  ${TYPES[l.type]}  |  MC ${mc}`;
    li.append(b, d);
    if (l.followDate) { const e = document.createElement('div'); e.textContent = `Follow up: ${l.followDate}${isDue(l) ? ' (due)' : ''}`; if (isDue(l)) e.className = 'due'; li.append(e); }
    if (S.notes[mc]) { const n = document.createElement('div'); n.className = 'muted'; n.textContent = S.notes[mc]; li.append(n); }
    const r = document.createElement('div'); r.className = 'row';
    const open = document.createElement('button'); open.textContent = 'Open'; open.onclick = safe(() => openCarrier(c, false));
    const call = document.createElement('button'); call.textContent = 'Call'; call.className = 'primary'; call.onclick = safe(() => openCarrier(c, true));
    r.append(open, call); li.append(r); ul.append(li);
  }
}

// ---------- rendering ----------
function age(d) {
  const t = Date.parse(d);
  if (!d || isNaN(t)) return null;
  const m = Math.max(0, Math.floor((Date.now() - t) / 2629800000));
  return { months: m, text: m >= 12 ? `${Math.floor(m / 12)} yr ${m % 12} mo` : `${m} mo` };
}
function row(dl, k, v, cls) {
  const dt = document.createElement('dt'), dd = document.createElement('dd');
  dt.textContent = k; dd.textContent = v;
  if (cls) dd.className = cls;
  dl.append(dt, dd);
}
const OPS = { A: 'Interstate', B: 'Intrastate (hazmat)', C: 'Intrastate (non-hazmat)' };
const GV = { nogv: ['Open Google Voice tab', 'bad'], unknown: ['Voice: cannot read page', 'warn'],
  idle: ['Voice: ready', 'ok'], oncall: ['On a call', 'call'] };

function render() {
  const [gt, gc] = GV[S.gv] || GV.unknown;
  $('gv').textContent = gt; $('gv').className = 'pill ' + gc;
  const t0 = new Date().toDateString();
  const done = Object.values(S.calls).filter((l) => l.status !== 'skipped' && new Date(l.ts).toDateString() === t0).length;
  const due = Object.values(S.leads).filter(isDue).length;
  $('counts').textContent = `Today: ${done}${S.cfg.dailyGoal ? ' / ' + S.cfg.dailyGoal : ''}   Follow-ups due: ${due}`;

  let status = S.msg;
  if (S.paused) status = 'Paused. ' + status;
  if (S.phase === 'oncall') status = 'On a call. Next dial is locked until you hang up.';
  if (S.phase === 'wrapup' && S.left) status = `Next call in ${S.left}s. Press Pause to stop it.`;
  if (S.phase === 'done' && !S.cur) status = 'No more carriers match your filters. Change the truck limits, jump to another MC, or load a new queue.';
  $('status').textContent = status;

  if (S.cur) {
    const b = blockOf(S.cur.mc), z = Number(S.cfg.blockSize) || 10000;
    const key = `${S.cur.mc}|${Object.keys(S.calls).length}|${Object.keys(S.leads).length}|${S.cfg.minFleet}|${S.cfg.maxFleet}|${z}|${S.run}`;
    if (S.bkey !== key) { S.bkey = key; S.bleft = S.queue.filter((c) => blockOf(c.mc) === b && eligible(c)).length; }
    $('blockInfo').textContent = `Block ${b} to ${b + z - 1}, pass ${S.run}: ${S.bleft} still to call`;
  } else $('blockInfo').textContent = '';

  $('empty').hidden = S.phase !== 'empty';
  $('carrier').hidden = !S.cur;
  if (S.cur) {
    const c = S.cur, lead = S.leads[c.mc];
    $('name').textContent = (c.name || 'Unknown carrier') + (c.dba ? ` (${c.dba})` : '');
    $('ids').textContent = `MC ${c.mc}   DOT ${c.dot ?? ''}${S.isManual ? '   (manual call, not counted in stats)' : ''}`;
    $('phone').textContent = fmtPhone(c.phone);
    $('fleet').textContent = `${c.units ?? '?'} trucks, ${c.drivers ?? '?'} drivers`;
    $('owner').textContent = c.owner || '—';
    $('email').textContent = c.email || '—';
    $('addr').textContent = [c.street, `${c.city ?? ''}, ${c.state ?? ''} ${c.zip ?? ''}`].filter(Boolean).join(', ');
    const more = $('more'); more.textContent = '';
    const a = age(c.added), m = age(c.mcs150);
    row(more, 'DOT record added', a ? `${c.added} (${a.text} ago)` : '—');
    row(more, 'Last MCS-150 update', m ? `${c.mcs150} (${m.text} ago)${m.months > 24 ? ' - stale' : ''}` : '—', m && m.months > 24 ? 'stale' : '');
    row(more, 'Operation', OPS[c.op] || c.op || '—');
    row(more, 'Carrier class', c.cls || '—');
    row(more, 'Hazmat', c.hazmat ? 'Yes' : 'No');
    row(more, 'General freight', 'Yes');
    if (c.phone2) row(more, 'Other phone', fmtPhone(c.phone2));
    $('safer').href = `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${encodeURIComponent(c.dot ?? '')}`;
    const sk = c.mc + (S.isManual ? 'm' : '');
    if (S.shown !== sk) {                       // only reset inputs when the carrier changes
      S.shown = sk;
      $('note').value = S.notes[c.mc] || '';
      $('followDate').value = (lead && lead.followDate) || '';
    }
    $('savedTag').textContent = lead ? `Saved as ${TYPES[lead.type]}${lead.followDate ? `, follow up ${lead.followDate}` : ''}. Not dialed automatically.` : '';
    $('unsave').hidden = !lead;
    document.querySelectorAll('#saveAs button').forEach((bn) => { bn.style.outline = lead && lead.type === bn.dataset.t ? '2px solid var(--acc)' : ''; });
    const cl = S.calls[ckey()];
    document.querySelectorAll('#outcomes button').forEach((bn) => { bn.style.outline = cl && cl.status === bn.dataset.o ? '2px solid var(--acc)' : ''; });
  }
  const locked = S.phase === 'dialing' || S.phase === 'oncall';
  $('dial').disabled = !S.cur || locked || S.gv !== 'idle' || S.busy;
  $('dial').textContent = S.phase === 'wrapup' ? 'Dial next' : 'Dial';
  $('skip').disabled = !S.cur || locked;
  $('skip').textContent = S.isManual ? 'Close' : 'Skip';
  $('pause').textContent = S.paused ? 'Resume' : 'Pause';
  $('autoDial').checked = !!S.cfg.autoDial;
  document.querySelectorAll('#outcomes button, #saveAs button, #copy, #unsave').forEach((bn) => { bn.disabled = !S.cur; });
}

// ---------- setup ----------
function fillSettings() {
  for (const k of ['maxFleet', 'minFleet', 'delaySec', 'dailyGoal', 'blockSize', 'webKey', 'endRe', 'callRe', 'readyRe']) $(k).value = S.cfg[k];
  $('dryRun').checked = S.cfg.dryRun; $('liveCheck').checked = S.cfg.liveCheck;
}

function bind() {
  $('dial').onclick = safe(go); $('skip').onclick = safe(skip); $('pause').onclick = safe(togglePause);
  $('copy').onclick = safe(copyInfo); $('export').onclick = safe(exportCalls);
  $('jump').onclick = safe(jump); $('exportStats').onclick = safe(exportStats); $('exportSaved').onclick = safe(exportSaved);
  $('jumpMc').onkeydown = (e) => { if (e.key === 'Enter') safe(jump)(); };
  $('file').onchange = safe((e) => loadFile(e.target.files[0]));
  $('file2').onchange = safe((e) => loadFile(e.target.files[0]));
  document.querySelectorAll('#outcomes button').forEach((b) => (b.onclick = safe(() => outcome(b.dataset.o))));
  document.querySelectorAll('#saveAs button').forEach((b) => (b.onclick = safe(() => saveLead(b.dataset.t))));
  $('unsave').onclick = safe(unsave);
  $('savedFilter').onchange = safe(renderSaved);
  $('note').oninput = (e) => { if (!S.cur) return; const v = e.target.value; if (v) S.notes[S.cur.mc] = v; else delete S.notes[S.cur.mc]; saveSoon(); };
  $('followDate').onchange = safe((e) => { const l = S.cur && S.leads[S.cur.mc]; if (l) { l.followDate = e.target.value; save(); renderSaved(); render(); } });
  $('autoDial').onchange = safe((e) => { S.cfg.autoDial = e.target.checked; if (!e.target.checked) { clearInterval(S.timer); S.left = 0; } save(); render(); });
  $('dryRun').onchange = safe((e) => { S.cfg.dryRun = e.target.checked; save(); });
  $('liveCheck').onchange = safe((e) => {
    S.cfg.liveCheck = e.target.checked;
    if (e.target.checked && !S.cfg.webKey) S.msg = 'Live check is on but no FMCSA webKey is set, so it will do nothing until you add one.';
    save(); render();
  });
  $('webKey').onchange = safe((e) => { S.cfg.webKey = e.target.value.trim(); save(); });
  for (const k of ['maxFleet', 'minFleet']) {
    $(k).onchange = safe((e) => {
      const n = Number(e.target.value), ok = e.target.value !== '' && n >= 0;
      S.cfg[k] = ok ? Math.floor(n) : DEF[k];
      if (S.cfg.minFleet > S.cfg.maxFleet) { S.msg = 'Min trucks cannot be above max trucks. Adjusted.'; S.cfg.minFleet = S.cfg.maxFleet; }
      fillSettings();
      if (S.phase === 'ready' && !S.isManual || S.phase === 'done') { S.parked = null; S.idx = 0; nextCarrier(); }
      save(); render();
    });
  }
  $('delaySec').onchange = safe((e) => { S.cfg.delaySec = Math.max(3, Number(e.target.value) || 10); fillSettings(); save(); });
  $('dailyGoal').onchange = safe((e) => { S.cfg.dailyGoal = Math.max(0, Math.floor(Number(e.target.value)) || 0); fillSettings(); save(); render(); });
  $('blockSize').onchange = safe((e) => { S.cfg.blockSize = Math.max(100, Math.floor(Number(e.target.value)) || 10000); fillSettings(); save(); renderStats(); render(); });
  for (const k of ['endRe', 'callRe', 'readyRe']) {
    $(k).onchange = safe((e) => {
      try { new RegExp(e.target.value); S.cfg[k] = e.target.value || DEF[k]; }
      catch { S.msg = 'That pattern is not valid. Kept the old one.'; }
      fillSettings(); save(); render();
    });
  }
  $('reset').onclick = safe(() => {
    if (!confirm('Clear the whole call history and stats? Saved carriers and notes are kept.')) return;
    S.calls = {}; S.run = 1; S.idx = 0; S.paused = false; S.parked = null; clearInterval(S.timer); S.left = 0;
    nextCarrier(); S.msg = 'History cleared.'; render(); renderStats();
  });
}

(async function init() {
  let d = {};
  try { d = await chrome.storage.local.get(['queue', 'cfg', 'idx', 'calls', 'leads', 'notes', 'run', 'curMc']); }
  catch { S.msg = 'Could not read saved data. Starting fresh.'; }
  S.cfg = { ...DEF, ...(d.cfg || {}) };
  S.calls = d.calls || {}; S.leads = d.leads || {}; S.notes = d.notes || {};
  S.run = d.run || 1; S.idx = d.idx || 0;
  setQueue(d.queue);
  if (S.queue.length) {
    const c = d.curMc && S.map[d.curMc];
    if (c && eligible(c)) { S.cur = c; S.phase = 'ready'; } else nextCarrier();
  } else if (Object.keys(S.leads).length) S.phase = 'done';
  bind(); fillSettings(); render(); renderStats(); renderSaved();
  setInterval(safe(poll), 1000);
})();
