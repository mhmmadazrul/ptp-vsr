/* ============================================================
   PTP Vessel Status Report — Kendo UI Core edition
   Vanilla JS + jQuery + Kendo UI Core (Apache-2.0) + Chart.js
   ============================================================ */
(function () {
'use strict';

// ── CONSTANTS ──────────────────────────────────────────────
const TARGET = { qs: 20, qsail: 17, idle: 37, rate: 80, srtWindow: 15 };
const GANTRY_M_PER_BAY = 17.5;
const DEFAULT_QC_SPEED = 50;

const WORKLOAD = [
  { id: 'f1', label: 'Normal container', unit: 'Unit', factor: 1.0 },
  { id: 'f2', label: 'Twin lift',        unit: 'Unit', factor: 0.5 },
  { id: 'f3', label: 'Gearbox',          unit: 'Unit', factor: 1.9157 },
  { id: 'f4', label: 'Hatch cover',      unit: 'Unit', factor: 1.5326 },
  { id: 'f5', label: 'OOG',              unit: 'Unit', factor: 3.0651 },
  { id: 'f6', label: 'Open top',         unit: 'Unit', factor: 1.9157 },
  { id: 'f7', label: 'Gantry movement',  unit: 'Bay' },
  { id: 'f8', label: 'Breakdown',        unit: 'Min' }
];

const PHASES = {
  arrival:    { label: 'Awaiting prediction', short: 'Predict', cls: 'st-arr',  icon: 'ti-calculator' },
  prediction: { label: 'Awaiting departure',  short: 'Depart',  cls: 'st-pred', icon: 'ti-clock-hour-4' },
  completed:  { label: 'Completed',           short: 'Done',    cls: 'st-done', icon: 'ti-circle-check' }
};

const VIEWS = [
  { id: 'arrival',    label: 'Arrival',    icon: 'ti-anchor' },
  { id: 'prediction', label: 'Prediction', icon: 'ti-calculator' },
  { id: 'departure',  label: 'Departure',  icon: 'ti-sailboat' },
  { id: 'records',    label: 'Records',    icon: 'ti-list-details' },
  { id: 'dashboard',  label: 'Dashboard',  icon: 'ti-chart-donut-3' }
];

// ── STATE ──────────────────────────────────────────────────
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};

let QC_DB = [];
const S = {
  view: store.get('ptp_view') || 'arrival',
  operator: store.get('ptp_op') || '',
  records: [],
  loaded: false,
  loading: false,
  arrDraft: { vessel: '', reference: '', fl: null, rtw: null, fli: null, remarks: '' },
  predSel: null,
  predDraft: { qc: '', cmph: null, f1: 0, f2: 0, f3: 0, f4: 0, f5: 0, f6: 0, f7: 0, f8: 0, remarks: '' },
  depSel: null,
  recFilter: 'all',
  recSearch: '',
  monthFilter: 'all',
  weekFilter: 'all'
};
let W = {};          // live Kendo widget refs for the current view
let charts = [];     // live Chart.js instances
let clockTimer = null;
let notifier = null;

// ── UTILITIES ──────────────────────────────────────────────
const $v = () => $('#view');
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const pad = n => String(n).padStart(2, '0');
const toHM = d => pad(d.getHours()) + ':' + pad(d.getMinutes());
const hmToMin = s => { const [h, m] = String(s).split(':'); return (+h) * 60 + (+m); };
const hmToDate = s => { const d = new Date(); const [h, m] = s.split(':'); d.setHours(+h, +m, 0, 0); return d; };
const addMin = (d, m) => new Date(d.getTime() + m * 60000);

/** Minutes from a → b on a 24h clock, midnight-aware.
 *  Result is in (-720, 720]: e.g. 23:50 → 00:05 = +15, 08:00 → 07:50 = -10. */
function circDiff(a, b) {
  let d = hmToMin(b) - hmToMin(a);
  if (d <= -720) d += 1440; else if (d > 720) d -= 1440;
  return d;
}
function roundUpTo15(d) {
  const r = new Date(d); r.setSeconds(0, 0);
  const rem = r.getMinutes() % 15;
  if (rem) r.setMinutes(r.getMinutes() + (15 - rem));
  return r;
}
const classify = (mins, target) => mins <= target ? 'GOOD' : 'NOT QUALITY';
function classifySRT(srt, actualLL) {
  const d = circDiff(actualLL, srt);            // minutes from last lift to SRT
  return (d >= 0 && d <= TARGET.srtWindow) ? 'GOOD' : 'NOT QUALITY';
}
const phaseOf = r => !r.predicted_last_lift_time ? 'arrival' : !r.actual_last_lift_time ? 'prediction' : 'completed';

function relTime(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' h ' + (m % 60) + ' m ago';
  const d = Math.floor(h / 24);
  return d + ' day' + (d > 1 ? 's' : '') + ' ago';
}
const fmtDate = iso => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const fmtDateTime = iso => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

// ISO week / month keys
function getWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const wk = Math.ceil((((d - yStart) / 86400000) + 1) / 7);
  return d.getUTCFullYear() + '-W' + pad(wk);
}
function weekRange(key) {
  const [yr, wk] = key.split('-W').map(Number);
  const simple = new Date(Date.UTC(yr, 0, 1 + (wk - 1) * 7));
  const dow = simple.getUTCDay() || 7;
  const mon = new Date(simple); mon.setUTCDate(simple.getUTCDate() - dow + 1);
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  return { mon, sun };
}
function weekLabel(key) {
  const { mon, sun } = weekRange(key);
  const f = d => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  return key.split('-')[1] + '  ·  ' + f(mon) + ' – ' + f(sun);
}
const getMonthKey = d => d.getFullYear() + '-M' + pad(d.getMonth() + 1);
const monthLabel = k => { const [y, m] = k.split('-M').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); };

// ── UI PRIMITIVES ──────────────────────────────────────────
function toast(msg, type) {
  if (!notifier) return;
  notifier.show(kendo.htmlEncode(String(msg)), type || 'info');
}

function badge(cls, text) {
  const good = cls === 'GOOD';
  return `<span class="pill ${good ? 'pill-good' : 'pill-bad'}"><i class="ti ${good ? 'ti-check' : 'ti-alert-triangle'}"></i>${esc(text || cls)}</span>`;
}
function phasePill(r) {
  const p = PHASES[phaseOf(r)];
  return `<span class="pill ${p.cls}"><i class="ti ${p.icon}"></i>${p.label}</span>`;
}

/** Opens a Kendo Dialog. actions: [{text, primary, action():bool|void}] */
function openDialog({ title, html, actions, width }) {
  const $d = $('<div class="vsr-dialog"></div>').appendTo(document.body);
  const dlg = $d.kendoDialog({
    title: title || false,
    content: html,
    width: (width || 520) + 'px',
    modal: true,
    closable: true,
    visible: false,
    buttonLayout: 'normal',
    actions: (actions || [{ text: 'Close', primary: true }]).map(a => ({
      text: a.text, primary: !!a.primary, action: a.action || (() => true)
    })),
    hide() { setTimeout(() => { kendo.destroy($d); $d.remove(); }, 0); }
  }).data('kendoDialog');
  dlg.open();
  return dlg;
}

function kButton(sel, opts) {
  return $(sel).kendoButton(Object.assign({ size: 'large' }, opts || {})).data('kendoButton');
}

function setBusy(btn, busy, label) {
  if (!btn) return;
  const $el = btn.element;
  if (busy) { $el.data('label', $el.find('.k-button-text').html()); btn.enable(false); $el.find('.k-button-text').html('<span class="spin"></span>' + (label || 'Saving…')); }
  else { btn.enable(true); if ($el.data('label')) $el.find('.k-button-text').html($el.data('label')); }
}

function timeField(id, label, hint) {
  return `<div class="fld">
    <label class="k-label fld-label" for="${id}">${label}</label>
    <div class="time-row">
      <input id="${id}" />
      <button type="button" class="now-btn" data-now="${id}" title="Set to current time" aria-label="Set ${label} to current time"><i class="ti ti-clock-bolt"></i>Now</button>
    </div>
    <div class="fld-msg" id="${id}-msg">${hint || ''}</div>
  </div>`;
}

function initTimePicker(id, value, onChange) {
  const el = document.getElementById(id);
  el.setAttribute('inputmode', 'numeric');
  el.setAttribute('placeholder', 'HH:mm');
  const w = $(el).kendoTimePicker({
    format: 'HH:mm',
    parseFormats: ['HH:mm', 'HHmm', 'H:mm', 'Hmm', 'HH.mm', 'H.mm'],
    interval: 5,
    size: 'large',
    value: value ? hmToDate(value) : null,
    change: onChange
  }).data('kendoTimePicker');
  $(el).on('keyup', e => { if (e.key === 'Enter') { w.value(w.element.val()); onChange(); } });
  return w;
}
function readTime(w) {
  if (!w) return { hm: null, bad: false };
  const v = w.value();
  if (v) return { hm: toHM(v), bad: false };
  const raw = String(w.element.val() || '').trim();
  return { hm: null, bad: raw.length > 0 };
}
function bindNowButtons(map) {
  $v().off('click.now').on('click.now', '[data-now]', function () {
    const w = map[this.getAttribute('data-now')];
    if (!w) return;
    w.value(new Date());
    w.trigger('change');
  });
}
function setMsg(id, text, kind) {
  const el = document.getElementById(id + '-msg');
  if (!el) return;
  el.className = 'fld-msg' + (kind ? ' is-' + kind : '');
  el.innerHTML = text || '';
  const wrap = $('#' + id).closest('.k-timepicker, .k-textbox, .k-numerictextbox, .k-textarea, .k-dropdownlist');
  wrap.toggleClass('k-invalid', kind === 'error');
}

function readNum(w) {
  if (!w) return 0;
  const raw = parseFloat(String(w.element.val() || '').replace(/,/g, ''));
  if (!isNaN(raw)) return raw;
  const v = w.value();
  return v == null ? 0 : v;
}

function stepper(active) {
  const steps = [['arrival', 'Arrival'], ['prediction', 'Prediction'], ['departure', 'Departure']];
  const idx = steps.findIndex(s => s[0] === active);
  return `<ol class="stepper" aria-label="Vessel call phases">${steps.map((s, i) =>
    `<li class="${i < idx ? 'done' : i === idx ? 'current' : ''}">
       <span class="dot">${i < idx ? '<i class="ti ti-check"></i>' : i + 1}</span><span class="lbl">${s[1]}</span>
     </li>`).join('')}</ol>`;
}

function emptyState(icon, title, body, action) {
  return `<div class="empty">
    <div class="empty-ic"><i class="ti ${icon}"></i></div>
    <div class="empty-t">${title}</div>
    <div class="empty-b">${body}</div>
    ${action ? `<button class="empty-cta" data-goto="${action.view}">${action.text}</button>` : ''}
  </div>`;
}

// ── DATA ───────────────────────────────────────────────────
async function loadQCDatabase() {
  try {
    const { data, error } = await window.sb.from('qc_database').select('*').order('qc_number');
    if (error) throw error;
    QC_DB = (data || [])
      .map(r => ({ qc: r.qc_number, model: r.model, speed: +r.travel_speed_mpm || DEFAULT_QC_SPEED }))
      .sort((a, b) => (parseInt(a.qc.replace(/\D/g, '')) || 0) - (parseInt(b.qc.replace(/\D/g, '')) || 0));
  } catch (e) {
    console.error('QC load failed', e);
    QC_DB = [];
  }
}

async function loadRecords(silent) {
  S.loading = true;
  $('#refresh-btn').addClass('is-spinning');
  try {
    const { data, error } = await window.sb.from('vsr_records').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    S.records = data || [];
    S.loaded = true;
  } catch (e) {
    console.error('Load error', e);
    if (!silent) toast('Could not load records: ' + (e.message || e), 'error');
  }
  S.loading = false;
  $('#refresh-btn').removeClass('is-spinning');
  updateNavCounts();
}

async function dbInsert(rec) {
  try {
    const { error } = await window.sb.from('vsr_records').insert([rec]);
    if (error) throw error;
    return true;
  } catch (e) { toast('Save failed: ' + (e.message || e), 'error'); return false; }
}
async function dbUpdate(id, updates) {
  try {
    const { error } = await window.sb.from('vsr_records').update(updates).eq('id', id);
    if (error) throw error;
    return true;
  } catch (e) { toast('Update failed: ' + (e.message || e), 'error'); return false; }
}

// ── SHELL ──────────────────────────────────────────────────
function renderRoot() {
  const root = document.getElementById('root');
  kendo.destroy(root);
  if (!S.operator) return renderLogin(root);

  root.innerHTML = `
  <header class="appbar">
    <div class="appbar-inner">
      <div class="brand">
        <div class="brand-ic"><i class="ti ti-ship"></i></div>
        <div class="brand-txt">
          <div class="brand-t">Vessel Status Report</div>
          <div class="brand-s">Port of Tanjung Pelepas</div>
        </div>
      </div>
      <div class="appbar-actions">
        <button id="refresh-btn" class="icon-btn" title="Refresh data" aria-label="Refresh data"><i class="ti ti-refresh"></i></button>
        <button id="op-btn" class="op-chip" title="Switch operator"><i class="ti ti-user-circle"></i><span>${esc(S.operator)}</span><i class="ti ti-switch-horizontal op-sw"></i></button>
      </div>
    </div>
    <nav class="tabs" role="tablist">
      ${VIEWS.map(v => `<button role="tab" class="tab" data-view="${v.id}" aria-selected="${S.view === v.id}">
          <i class="ti ${v.icon}"></i><span class="tab-l">${v.label}</span><span class="tab-n" data-count="${v.id}"></span>
        </button>`).join('')}
    </nav>
  </header>
  <main id="view" class="view" tabindex="-1"></main>
  <div id="notify"></div>`;

  const mobile = window.matchMedia('(max-width: 760px)').matches;
  notifier = $('#notify').kendoNotification({
    position: mobile ? { pinned: true, bottom: 86, right: 14 } : { pinned: true, bottom: 24, right: 24 },
    stacking: 'up',
    autoHideAfter: 4500,
    button: true,
    width: 'min(360px, calc(100vw - 28px))'
  }).data('kendoNotification');

  $('.tabs').on('click', '.tab', function () { go(this.getAttribute('data-view')); });
  $('#refresh-btn').on('click', async () => { await loadRecords(); renderView(); toast('Data refreshed', 'success'); });
  $('#op-btn').on('click', () => openDialog({
    title: 'Switch operator',
    html: `<p class="dlg-p">You are signed in as <b>${esc(S.operator)}</b>. Switch to a different employee ID?</p>`,
    width: 380,
    actions: [{ text: 'Cancel' }, { text: 'Switch operator', primary: true, action: () => { logout(); return true; } }]
  }));
  $(document).off('click.goto').on('click.goto', '[data-goto]', function () { go(this.getAttribute('data-goto')); });

  updateNavCounts();
  renderView();
}

function updateNavCounts() {
  const c = { arrival: 0, prediction: 0, completed: 0 };
  S.records.forEach(r => c[phaseOf(r)]++);
  const set = (id, n, hot) => $(`[data-count="${id}"]`).text(n || '').toggleClass('hot', !!hot && n > 0);
  set('prediction', c.arrival, true);
  set('departure', c.prediction, true);
  set('records', S.records.length);
}

function go(view, opts) {
  if (!VIEWS.some(v => v.id === view)) view = 'arrival';
  S.view = view;
  store.set('ptp_view', view);
  if (opts && opts.predSel !== undefined) S.predSel = opts.predSel;
  if (opts && opts.depSel !== undefined) S.depSel = opts.depSel;
  $('.tab').each(function () { this.setAttribute('aria-selected', this.getAttribute('data-view') === view); });
  renderView();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (view !== 'arrival') loadRecords(true).then(() => { if (S.view === view) refreshCurrentLists(); });
}

function teardownView() {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  charts.forEach(c => { try { c.destroy(); } catch (e) {} });
  charts = [];
  const el = document.getElementById('view');
  if (el) kendo.destroy(el);
  W = {};
}

function renderView() {
  teardownView();
  const v = $v();
  if (!v.length) return;
  v.off();
  if (!S.loaded && S.view !== 'arrival') {
    v.html('<div class="loading-block"><span id="ldr"></span><div>Loading records…</div></div>');
    $('#ldr').kendoLoader({ type: 'infinite-spinner', size: 'large' });
    return;
  }
  ({ arrival: renderArrival, prediction: renderPrediction, departure: renderDeparture, records: renderRecords, dashboard: renderDashboard })[S.view](v);
}

/** After a background reload, refresh just the vessel queues / lists without losing typed input */
function refreshCurrentLists() {
  if (!S.loaded) return;
  if (S.view === 'prediction' && !S.predSel) renderView();
  else if (S.view === 'departure' && !S.depSel) renderView();
  else if (S.view === 'records' && W.recDS) { W.recDS.data(filteredRecords()); updateFilterCounts(); }
  else if (S.view === 'dashboard' && !$v().children().length) renderView();
  else if (['prediction', 'departure'].includes(S.view) && $v().find('.loading-block').length) renderView();
}

// ── LOGIN ──────────────────────────────────────────────────
function renderLogin(root) {
  root.innerHTML = `
  <div class="login">
    <div class="login-card">
      <div class="login-hero">
        <div class="brand-ic lg"><i class="ti ti-ship"></i></div>
        <h1>Vessel Status Report</h1>
        <p>Port of Tanjung Pelepas</p>
      </div>
      <form id="login-form" class="login-body" autocomplete="on">
        <label class="k-label fld-label" for="op-inp">Employee ID</label>
        <input id="op-inp" name="employee-id" autocomplete="username" />
        <div class="fld-msg" id="op-inp-msg">Used to stamp who recorded each phase.</div>
        <button id="login-btn" type="submit">Enter system</button>
      </form>
      <ul class="login-steps">
        <li><i class="ti ti-anchor"></i>Arrival · Quick Start ≤ ${TARGET.qs} min</li>
        <li><i class="ti ti-calculator"></i>Prediction · Recommended SRT</li>
        <li><i class="ti ti-sailboat"></i>Departure · Quick Sail ≤ ${TARGET.qsail} min</li>
      </ul>
    </div>
  </div>`;
  const tb = $('#op-inp').kendoTextBox({ placeholder: 'e.g. 012345', size: 'large', prefixOptions: { icon: 'user' } }).data('kendoTextBox');
  $('#op-inp').css('text-transform', 'uppercase');
  kButton('#login-btn', { themeColor: 'primary' });
  setTimeout(() => tb.focus(), 50);
  $('#login-form').on('submit', e => {
    e.preventDefault();
    const v = String(tb.value() || '').trim().toUpperCase();
    if (!v) { setMsg('op-inp', 'Please enter your employee ID.', 'error'); tb.focus(); return; }
    S.operator = v; store.set('ptp_op', v);
    renderRoot();
    loadRecords().then(() => refreshCurrentLists());
  });
}
function logout() {
  S.operator = ''; store.del('ptp_op');
  teardownView();
  renderRoot();
}

// ── PHASE 1: ARRIVAL ──────────────────────────────────────
function renderArrival(v) {
  const d = S.arrDraft;
  v.html(`
  ${stepper('arrival')}
  <div class="layout">
    <div class="col-main">
      <section class="card">
        <h2 class="card-t"><i class="ti ti-ship"></i>Vessel information</h2>
        <div class="grid g2">
          <div class="fld">
            <label class="k-label fld-label" for="a-vessel">Vessel name <span class="req">*</span></label>
            <input id="a-vessel" />
            <div class="fld-msg" id="a-vessel-msg"></div>
          </div>
          <div class="fld">
            <label class="k-label fld-label" for="a-ref">Vessel reference <span class="req">*</span></label>
            <input id="a-ref" />
            <div class="fld-msg" id="a-ref-msg"></div>
          </div>
        </div>
      </section>

      <section class="card">
        <h2 class="card-t"><i class="ti ti-clock"></i>Arrival times <span class="card-hint">24-hour · type 0830 or tap Now</span></h2>
        <div class="grid g3">
          ${timeField('a-fl', 'First line')}
          ${timeField('a-rtw', 'Vessel secured (RTW)')}
          ${timeField('a-fli', 'First lift')}
        </div>
        <div class="rule"><i class="ti ti-shield-check"></i>Poka-yoke: First Line ≤ RTW ≤ First Lift. Times that cross midnight are handled automatically.</div>
      </section>

      <section class="card">
        <h2 class="card-t"><i class="ti ti-message-2"></i>Remarks <span class="req">*</span></h2>
        <textarea id="a-rem"></textarea>
        <div class="fld-msg" id="a-rem-msg"></div>
      </section>
    </div>

    <aside class="col-side">
      <section class="card result sticky" id="arr-result"></section>
      <button id="a-save" class="save-btn"><i class="ti ti-device-floppy"></i>&nbsp;Save arrival</button>
      <button id="a-clear" class="link-btn" type="button"><i class="ti ti-eraser"></i> Clear form</button>
    </aside>
  </div>`);

  W.vessel = $('#a-vessel').kendoTextBox({ placeholder: 'e.g. EVER GIVEN', size: 'large', value: d.vessel }).data('kendoTextBox');
  $('#a-vessel').css('text-transform', 'uppercase').on('input', function () { S.arrDraft.vessel = this.value.toUpperCase(); setMsg('a-vessel', ''); });
  W.ref = $('#a-ref').kendoTextBox({ placeholder: 'e.g. VOY-2026-001', size: 'large', value: d.reference }).data('kendoTextBox');
  $('#a-ref').on('input', function () { S.arrDraft.reference = this.value; setMsg('a-ref', ''); });

  const onT = () => evalArrival();
  W.fl = initTimePicker('a-fl', d.fl, onT);
  W.rtw = initTimePicker('a-rtw', d.rtw, onT);
  W.fli = initTimePicker('a-fli', d.fli, onT);
  bindNowButtons({ 'a-fl': W.fl, 'a-rtw': W.rtw, 'a-fli': W.fli });

  W.rem = $('#a-rem').kendoTextArea({ rows: 3, maxLength: 500, placeholder: 'Anything that affected the arrival — berth readiness, lashing gang, crane availability…', size: 'large', value: d.remarks, resize: 'vertical' }).data('kendoTextArea');
  $('#a-rem').on('input', function () { S.arrDraft.remarks = this.value; setMsg('a-rem', ''); });

  W.save = kButton('#a-save', { themeColor: 'primary' });
  W.save.bind('click', saveArrival);
  $('#a-clear').on('click', () => { S.arrDraft = { vessel: '', reference: '', fl: null, rtw: null, fli: null, remarks: '' }; renderView(); });

  evalArrival();
}

function evalArrival() {
  const fl = readTime(W.fl), rtw = readTime(W.rtw), fli = readTime(W.fli);
  Object.assign(S.arrDraft, { fl: fl.hm, rtw: rtw.hm, fli: fli.hm });
  let ok = true;
  [['a-fl', fl], ['a-rtw', rtw], ['a-fli', fli]].forEach(([id, t]) => {
    if (t.bad) { setMsg(id, 'Enter time as HH:mm (e.g. 08:30)', 'error'); ok = false; }
    else setMsg(id, '');
  });
  let seqErr = null;
  if (fl.hm && rtw.hm && circDiff(fl.hm, rtw.hm) < 0) {
    seqErr = `RTW (${rtw.hm}) is earlier than First Line (${fl.hm}).`;
    setMsg('a-rtw', '<i class="ti ti-alert-triangle"></i> Earlier than First Line', 'error'); ok = false;
  }
  if (rtw.hm && fli.hm && circDiff(rtw.hm, fli.hm) < 0) {
    seqErr = `First Lift (${fli.hm}) is earlier than RTW (${rtw.hm}).`;
    setMsg('a-fli', '<i class="ti ti-alert-triangle"></i> Earlier than RTW', 'error'); ok = false;
  }
  if (ok && fl.hm && rtw.hm) setMsg('a-rtw', `+${circDiff(fl.hm, rtw.hm)} min after First Line`, 'ok');

  const box = $('#arr-result');
  if (!(fl.hm && rtw.hm && fli.hm)) {
    box.html(resultPlaceholder('Quick Start', 'Enter all three arrival times to see Quick Start.', TARGET.qs));
    return null;
  }
  if (!ok) {
    box.html(`<div class="res-head">Quick Start</div>
      <div class="res-error"><i class="ti ti-alert-octagon"></i><div><b>Sequence error</b><br>${esc(seqErr || 'Check the times entered.')}</div></div>`);
    return null;
  }
  const qs = circDiff(rtw.hm, fli.hm);
  const cls = classify(qs, TARGET.qs);
  box.html(`
    <div class="res-head">Quick Start <span class="res-sub">First Lift − RTW</span></div>
    ${bigMetric(qs, 'min', cls, TARGET.qs)}
    ${gauge(qs, TARGET.qs)}
    <div class="timeline">
      ${tlStep('First line', fl.hm)}
      ${tlGap(circDiff(fl.hm, rtw.hm))}
      ${tlStep('RTW', rtw.hm)}
      ${tlGap(qs, cls)}
      ${tlStep('First lift', fli.hm)}
    </div>`);
  return { fl: fl.hm, rtw: rtw.hm, fli: fli.hm, qs, cls };
}

function resultPlaceholder(title, text, target) {
  return `<div class="res-head">${title}</div>
    <div class="res-empty"><i class="ti ti-hourglass-empty"></i><div>${text}</div></div>
    ${target != null ? `<div class="res-target">Target ≤ ${target} min</div>` : ''}`;
}
function bigMetric(val, unit, cls, target) {
  return `<div class="big ${cls === 'GOOD' ? 'good' : 'bad'}">
      <span class="big-n">${val}</span><span class="big-u">${unit}</span>
      ${badge(cls)}
    </div>
    <div class="res-target">Target ≤ ${target} ${unit} · ${cls === 'GOOD' ? `${target - val} ${unit} under target` : `${val - target} ${unit} over target`}</div>`;
}
function gauge(val, target) {
  const max = Math.max(target * 2, val);
  const pct = Math.min(100, val / max * 100);
  const tpct = target / max * 100;
  return `<div class="gauge" role="img" aria-label="${val} of ${target} target">
    <div class="gauge-fill ${val <= target ? 'good' : 'bad'}" style="width:${pct}%"></div>
    <div class="gauge-tgt" style="left:${tpct}%"><span>${target}</span></div>
  </div>`;
}
const tlStep = (label, t) => `<div class="tl-step"><span class="tl-dot"></span><span class="tl-l">${label}</span><span class="tl-t">${t}</span></div>`;
const tlGap = (m, cls) => `<div class="tl-gap ${cls ? (cls === 'GOOD' ? 'good' : 'bad') : ''}">${m} min</div>`;

async function saveArrival() {
  const vessel = String(W.vessel.value() || '').trim().toUpperCase();
  const ref = String(W.ref.value() || '').trim();
  const rem = String(W.rem.value() || '').trim();
  const r = evalArrival();
  const errs = [];
  if (!vessel) { setMsg('a-vessel', 'Vessel name is required', 'error'); errs.push('vessel name'); }
  if (!ref) { setMsg('a-ref', 'Vessel reference is required', 'error'); errs.push('reference'); }
  if (!r) {
    ['a-fl', 'a-rtw', 'a-fli'].forEach((id, i) => { if (!readTime([W.fl, W.rtw, W.fli][i]).hm) setMsg(id, 'Required', 'error'); });
    errs.push('valid arrival times');
  }
  if (!rem) { setMsg('a-rem', 'Remarks are mandatory', 'error'); errs.push('remarks'); }
  if (errs.length) { toast('Please complete: ' + errs.join(', '), 'warning'); return; }

  const dup = S.records.find(x => phaseOf(x) !== 'completed' && x.vessel_name === vessel && x.vessel_reference === ref);
  if (dup && !saveArrival._confirmed) {
    openDialog({
      title: 'Possible duplicate',
      html: `<p class="dlg-p"><b>${esc(vessel)} · ${esc(ref)}</b> already has an open record (${esc(PHASES[phaseOf(dup)].label.toLowerCase())}, created ${esc(relTime(dup.created_at))}).</p><p class="dlg-p">Save another arrival anyway?</p>`,
      width: 420,
      actions: [{ text: 'Cancel' }, { text: 'Save anyway', primary: true, action: () => { saveArrival._confirmed = true; saveArrival().finally(() => { saveArrival._confirmed = false; }); return true; } }]
    });
    return;
  }

  const rec = {
    id: genId(),
    vessel_name: vessel,
    vessel_reference: ref,
    first_line_time: r.fl,
    rtw_time: r.rtw,
    first_lift_time: r.fli,
    quick_start_minutes: r.qs,
    quick_start_class: r.cls,
    arrival_remarks: rem,
    operator_id: S.operator,
    created_at: new Date().toISOString()
  };
  setBusy(W.save, true);
  const ok = await dbInsert(rec);
  setBusy(W.save, false);
  if (!ok) return;

  S.records.unshift(rec);
  updateNavCounts();
  S.arrDraft = { vessel: '', reference: '', fl: null, rtw: null, fli: null, remarks: '' };
  toast(`Arrival saved · ${rec.vessel_name}`, 'success');
  openDialog({
    title: 'Arrival saved',
    html: `<div class="dlg-sum">
      <div class="dlg-vessel"><i class="ti ti-ship"></i>${esc(rec.vessel_name)} <span>· ${esc(rec.vessel_reference)}</span></div>
      <div class="dlg-kv"><span>Quick Start</span><b>${rec.quick_start_minutes} min</b>${badge(rec.quick_start_class)}</div>
      <p class="dlg-p muted">Next: record the departure prediction once the final crane plan is known.</p>
    </div>`,
    width: 420,
    actions: [
      { text: 'New arrival', action: () => { renderView(); return true; } },
      { text: 'Go to prediction', primary: true, action: () => { go('prediction', { predSel: rec.id }); return true; } }
    ]
  });
  renderView();
}

// ── VESSEL QUEUE (shared by phase 2/3) ─────────────────────
function queueHTML(list, selId, kind) {
  return `<div class="queue" role="listbox" aria-label="Vessels">
    ${list.map(r => {
      const sel = r.id === selId;
      const meta = kind === 'dep'
        ? `<span><i class="ti ti-target-arrow"></i>SRT <b>${esc(r.suggested_srt)}</b></span><span><i class="ti ti-crane"></i>${esc(r.qc_number || '—')}</span>`
        : `<span><i class="ti ti-player-play"></i>QS <b>${esc(r.quick_start_minutes)}m</b></span><span><i class="ti ti-clock"></i>${esc(relTime(r.created_at))}</span>`;
      return `<button class="q-item ${sel ? 'sel' : ''}" role="option" aria-selected="${sel}" data-id="${esc(r.id)}">
        <span class="q-ic"><i class="ti ti-ship"></i></span>
        <span class="q-body">
          <span class="q-name">${esc(r.vessel_name)}</span>
          <span class="q-ref">${esc(r.vessel_reference)}</span>
          <span class="q-meta">${meta}</span>
        </span>
        <i class="ti ${sel ? 'ti-circle-check-filled' : 'ti-chevron-right'} q-chev"></i>
      </button>`;
    }).join('')}
  </div>`;
}

function selectedStrip(r, extra) {
  return `<div class="sel-strip">
    <div class="sel-v"><i class="ti ti-ship"></i><div><b>${esc(r.vessel_name)}</b><span>${esc(r.vessel_reference)} · by ${esc(r.operator_id)} · ${esc(fmtDateTime(r.created_at))}</span></div></div>
    <div class="sel-kpis">
      <div><span>Quick Start</span><b>${esc(r.quick_start_minutes)}m</b>${badge(r.quick_start_class, r.quick_start_class === 'GOOD' ? 'GOOD' : 'NQ')}</div>
      ${extra || ''}
    </div>
    <button class="link-btn" data-change>Change vessel</button>
  </div>`;
}

// ── PHASE 2: DEPARTURE PREDICTION ─────────────────────────
function renderPrediction(v) {
  const pending = S.records.filter(r => phaseOf(r) === 'arrival');
  if (S.predSel && !pending.some(r => r.id === S.predSel)) S.predSel = null;

  if (!pending.length) {
    v.html(stepper('prediction') + `<section class="card">${emptyState('ti-anchor', 'No vessels awaiting prediction', 'Save an arrival first — it will appear here ready for the departure prediction.', { view: 'arrival', text: 'Record an arrival' })}</section>`);
    return;
  }
  if (!S.predSel) {
    v.html(stepper('prediction') + `<section class="card">
      <h2 class="card-t"><i class="ti ti-list"></i>Select vessel <span class="card-hint">${pending.length} awaiting prediction</span></h2>
      ${queueHTML(pending, null, 'pred')}
    </section>`);
    v.on('click', '.q-item', function () { S.predSel = this.getAttribute('data-id'); S.predDraft = { qc: '', cmph: null, f1: 0, f2: 0, f3: 0, f4: 0, f5: 0, f6: 0, f7: 0, f8: 0, remarks: '' }; renderView(); });
    return;
  }

  const r = S.records.find(x => x.id === S.predSel);
  const d = S.predDraft;
  v.html(`
  ${stepper('prediction')}
  ${selectedStrip(r)}
  <div class="layout">
    <div class="col-main">
      <section class="card">
        <h2 class="card-t"><i class="ti ti-crane"></i>Crane setup</h2>
        <div class="grid g2">
          <div class="fld">
            <label class="k-label fld-label" for="p-qc">Last crane (QC) <span class="req">*</span></label>
            <input id="p-qc" />
            <div class="fld-msg" id="p-qc-msg">${QC_DB.length ? QC_DB.length + ' cranes available' : '<span class="warn">QC list unavailable — default speed 50 m/min used</span>'}</div>
          </div>
          <div class="fld">
            <label class="k-label fld-label" for="p-cmph">CMPH <span class="req">*</span></label>
            <input id="p-cmph" />
            <div class="fld-msg" id="p-cmph-msg"></div>
          </div>
        </div>
      </section>

      <section class="card">
        <h2 class="card-t"><i class="ti ti-box-multiple"></i>Remaining workload <span class="card-hint">for the last crane</span></h2>
        <div class="grid g2 wl">
          ${WORKLOAD.map(f => `<div class="fld">
            <label class="k-label fld-label" for="p-${f.id}">${f.label}</label>
            <input id="p-${f.id}" />
            <div class="fld-msg" id="p-${f.id}-msg"></div>
          </div>`).join('')}
        </div>
      </section>

      <section class="card">
        <h2 class="card-t"><i class="ti ti-message-2"></i>Remarks <span class="card-hint">optional</span></h2>
        <textarea id="p-rem"></textarea>
      </section>
    </div>
    <aside class="col-side">
      <section class="card result sticky" id="pred-result"></section>
      <button id="p-save" class="save-btn"><i class="ti ti-device-floppy"></i>&nbsp;Save prediction</button>
    </aside>
  </div>`);

  v.on('click', '[data-change]', () => { S.predSel = null; renderView(); });

  W.qc = $('#p-qc').kendoDropDownList({
    dataSource: QC_DB,
    dataTextField: 'qc',
    dataValueField: 'qc',
    optionLabel: 'Select crane…',
    filter: 'contains',
    size: 'large',
    value: d.qc,
    template: q => `<div class="qc-opt"><b>${esc(q.qc)}</b><span>${esc(q.model || '')} · ${esc(q.speed)} m/min</span></div>`,
    valueTemplate: q => q && q.qc ? `<span class="qc-val"><b>${esc(q.qc)}</b> <span>${esc(q.model || '')} · ${esc(q.speed)} m/min</span></span>` : '<span class="k-input-value-text">Select crane…</span>',
    change() { S.predDraft.qc = this.value(); setMsg('p-qc', ''); evalPrediction(); }
  }).data('kendoDropDownList');

  $('#p-cmph').attr('inputmode', 'decimal');
  W.cmph = $('#p-cmph').kendoNumericTextBox({
    min: 1, max: 80, step: 1, decimals: 1, format: '#.#', size: 'large', placeholder: 'e.g. 28', value: d.cmph,
    suffixOptions: { template: () => 'moves/hr' },
    change() { evalPrediction(); }, spin() { evalPrediction(); }
  }).data('kendoNumericTextBox');
  W.cmph.wrapper.find('input').attr('inputmode', 'decimal');
  $('#p-cmph').on('input', () => evalPrediction());

  WORKLOAD.forEach(f => {
    $('#p-' + f.id).attr('inputmode', 'numeric');
    W[f.id] = $('#p-' + f.id).kendoNumericTextBox({
      min: 0, step: 1, decimals: 0, format: 'n0', size: 'large', placeholder: '0', value: d[f.id] || null,
      suffixOptions: { template: () => f.unit },
      change: () => evalPrediction(), spin: () => evalPrediction()
    }).data('kendoNumericTextBox');
    W[f.id].wrapper.find('input').attr('inputmode', 'numeric');
    $('#p-' + f.id).on('input', () => evalPrediction());
  });

  W.rem = $('#p-rem').kendoTextArea({ rows: 2, maxLength: 500, placeholder: 'Assumptions — e.g. lashing delay expected, re-stow on bay 32…', size: 'large', value: d.remarks, resize: 'vertical' }).data('kendoTextArea');
  $('#p-rem').on('input', function () { S.predDraft.remarks = this.value; });

  W.save = kButton('#p-save', { themeColor: 'primary' });
  W.save.bind('click', savePrediction);

  evalPrediction();
  clockTimer = setInterval(evalPrediction, 30000);
}

function calcPrediction(f, cmph, qcSpeed) {
  const base = 60 / cmph;
  let containerMin = 0;
  WORKLOAD.forEach(w => { if (w.factor) containerMin += (+f[w.id] || 0) * base * w.factor; });
  const gantryMin = (+f.f7 || 0) * GANTRY_M_PER_BAY / qcSpeed;
  const bufferMin = +f.f8 || 0;
  return { containerMin, gantryMin, bufferMin, totalMin: containerMin + gantryMin + bufferMin };
}

function evalPrediction() {
  if (!W.cmph) return null;
  const d = S.predDraft;
  d.cmph = readNum(W.cmph) || null;
  WORKLOAD.forEach(f => { d[f.id] = Math.max(0, readNum(W[f.id])); });
  const qc = QC_DB.find(q => q.qc === d.qc);
  const speed = qc ? qc.speed : DEFAULT_QC_SPEED;
  const cmph = d.cmph || 0;
  const base = cmph > 0 ? 60 / cmph : 0;

  setMsg('p-cmph', cmph > 0 ? `${base.toFixed(2)} min per move` : '');
  WORKLOAD.forEach(f => {
    const q = d[f.id];
    let t = '';
    if (f.factor && cmph && q) t = `${(q * base * f.factor).toFixed(1)} min <span class="muted">· ×${f.factor}</span>`;
    else if (f.id === 'f7' && q) t = `${(q * GANTRY_M_PER_BAY / speed).toFixed(1)} min travel <span class="muted">· ${speed} m/min</span>`;
    else if (f.id === 'f8' && q) t = 'Added directly to total';
    setMsg('p-' + f.id, t);
  });

  const box = $('#pred-result');
  const totalMoves = WORKLOAD.filter(f => f.factor).reduce((s, f) => s + d[f.id], 0);
  if (!d.qc || !(cmph > 0) || (!totalMoves && !d.f7 && !d.f8)) {
    const need = [!d.qc && 'crane', !(cmph > 0) && 'CMPH', (!totalMoves && !d.f7 && !d.f8) && 'workload'].filter(Boolean).join(', ');
    box.html(resultPlaceholder('Predicted last lift', `Enter ${need} to see the recommended SRT.`));
    return null;
  }
  const res = calcPrediction(d, cmph, speed);
  const now = new Date();
  const ll = addMin(now, res.totalMin);
  const srt = roundUpTo15(ll);
  const nextDay = ll.getDate() !== now.getDate();
  const parts = [['Container work', res.containerMin, 'c1'], ['Gantry travel', res.gantryMin, 'c2'], ['Breakdown', res.bufferMin, 'c3']];
  box.html(`
    <div class="res-head">Departure prediction <span class="res-sub live"><span class="live-dot"></span>live · now ${toHM(now)}</span></div>
    <div class="pred-times">
      <div class="pt"><span>Predicted last lift</span><b class="t-blue">${toHM(ll)}</b>${nextDay ? '<em>+1 day</em>' : ''}</div>
      <div class="pt srt"><span>Recommended SRT</span><b>${toHM(srt)}</b><em>call pilot for this time</em></div>
    </div>
    <div class="stack" role="img" aria-label="Operation time breakdown">
      ${parts.filter(p => p[1] > 0).map(p => `<div class="${p[2]}" style="flex:${p[1]}" title="${p[0]}: ${p[1].toFixed(1)} min"></div>`).join('')}
    </div>
    <div class="kv">
      ${parts.map(p => `<div><span><i class="sw ${p[2]}"></i>${p[0]}</span><b>${p[1].toFixed(1)} min</b></div>`).join('')}
      <div class="kv-total"><span>Total operation time</span><b>${res.totalMin.toFixed(1)} min · ${Math.floor(res.totalMin / 60)}h ${pad(Math.round(res.totalMin % 60))}m</b></div>
    </div>
    <div class="rule sm"><i class="ti ti-info-circle"></i>SRT = predicted last lift rounded up to the next 15-min mark. GOOD if actual last lift lands in ${toHM(addMin(srt, -15))}–${toHM(srt)}.</div>`);
  return { res, ll, srt, qc, speed };
}

async function savePrediction() {
  const d = S.predDraft;
  const errs = [];
  if (!d.qc) { setMsg('p-qc', 'Select the last crane', 'error'); errs.push('crane'); }
  if (!(readNum(W.cmph) > 0)) { setMsg('p-cmph', 'CMPH is required', 'error'); errs.push('CMPH'); }
  if (errs.length) { toast('Please complete: ' + errs.join(', '), 'warning'); return; }
  const p = evalPrediction();          // recomputed against the clock right now
  if (!p) { toast('Enter the remaining workload before saving.', 'warning'); return; }
  const rem = String(W.rem.value() || '').trim();
  const id = S.predSel;
  const upd = {
    qc_number: d.qc, qc_model: p.qc ? p.qc.model : '', qc_speed: p.speed, cmph: +d.cmph,
    f1: +d.f1, f2: +d.f2, f3: +d.f3, f4: +d.f4, f5: +d.f5, f6: +d.f6, f7: +d.f7, f8: +d.f8,
    container_min: p.res.containerMin, gantry_min: p.res.gantryMin, buffer_min: p.res.bufferMin, total_min: p.res.totalMin,
    predicted_last_lift_time: toHM(p.ll), suggested_srt: toHM(p.srt),
    prediction_remarks: rem, prediction_operator: S.operator
  };
  setBusy(W.save, true);
  const ok = await dbUpdate(id, upd);
  setBusy(W.save, false);
  if (!ok) return;

  const rec = S.records.find(x => x.id === id);
  Object.assign(rec, upd);
  updateNavCounts();
  S.predSel = null;
  S.predDraft = { qc: '', cmph: null, f1: 0, f2: 0, f3: 0, f4: 0, f5: 0, f6: 0, f7: 0, f8: 0, remarks: '' };
  toast(`Prediction saved · ${rec.vessel_name}`, 'success');
  openDialog({
    title: 'Prediction saved',
    html: `<div class="dlg-sum">
      <div class="dlg-vessel"><i class="ti ti-ship"></i>${esc(rec.vessel_name)} <span>· ${esc(rec.vessel_reference)}</span></div>
      <div class="dlg-call"><span>Call pilot for SRT</span><b>${esc(upd.suggested_srt)}</b></div>
      <div class="dlg-kv"><span>Predicted last lift</span><b>${esc(upd.predicted_last_lift_time)}</b></div>
      <div class="dlg-kv"><span>SRT GOOD window</span><b>${toHM(addMin(p.srt, -15))} – ${esc(upd.suggested_srt)}</b></div>
    </div>`,
    width: 420,
    actions: [
      { text: 'Stay here', action: () => { renderView(); return true; } },
      { text: 'Go to departure', primary: true, action: () => { go('departure', { depSel: id }); return true; } }
    ]
  });
  renderView();
}

// ── PHASE 3: ACTUAL DEPARTURE ─────────────────────────────
function renderDeparture(v) {
  const ready = S.records.filter(r => phaseOf(r) === 'prediction');
  if (S.depSel && !ready.some(r => r.id === S.depSel)) S.depSel = null;

  if (!ready.length) {
    v.html(stepper('departure') + `<section class="card">${emptyState('ti-calculator', 'No vessels awaiting departure', 'Vessels appear here after their departure prediction is saved.', { view: 'prediction', text: 'Go to prediction' })}</section>`);
    return;
  }
  if (!S.depSel) {
    v.html(stepper('departure') + `<section class="card">
      <h2 class="card-t"><i class="ti ti-list"></i>Select vessel <span class="card-hint">${ready.length} awaiting departure</span></h2>
      ${queueHTML(ready, null, 'dep')}
    </section>`);
    v.on('click', '.q-item', function () { S.depSel = this.getAttribute('data-id'); renderView(); });
    return;
  }

  const r = S.records.find(x => x.id === S.depSel);
  const winStart = toHM(addMin(hmToDate(r.suggested_srt), -TARGET.srtWindow));
  v.html(`
  ${stepper('departure')}
  ${selectedStrip(r, `
    <div><span>Pred. last lift</span><b class="t-blue">${esc(r.predicted_last_lift_time)}</b></div>
    <div><span>Rec. SRT</span><b class="t-green">${esc(r.suggested_srt)}</b></div>
    <div><span>GOOD window</span><b>${winStart}–${esc(r.suggested_srt)}</b></div>`)}
  <div class="layout">
    <div class="col-main">
      <section class="card">
        <h2 class="card-t"><i class="ti ti-clock"></i>Actual departure times <span class="card-hint">24-hour · type 1745 or tap Now</span></h2>
        <div class="grid g2">
          ${timeField('d-ll', 'Actual last lift')}
          ${timeField('d-po', 'Pilot onboard')}
          ${timeField('d-srt', 'Actual SRT')}
          ${timeField('d-line', 'Last line')}
        </div>
        <div class="rule"><i class="ti ti-shield-check"></i>Poka-yoke: Last Line cannot be earlier than Actual Last Lift.</div>
      </section>
      <section class="card">
        <h2 class="card-t"><i class="ti ti-message-2"></i>Remarks <span class="req">*</span></h2>
        <textarea id="d-rem"></textarea>
        <div class="fld-msg" id="d-rem-msg"></div>
      </section>
    </div>
    <aside class="col-side">
      <section class="card result sticky" id="dep-result"></section>
      <button id="d-save" class="save-btn"><i class="ti ti-device-floppy"></i>&nbsp;Save departure</button>
    </aside>
  </div>`);

  v.on('click', '[data-change]', () => { S.depSel = null; renderView(); });
  const onT = () => evalDeparture(r);
  W.ll = initTimePicker('d-ll', null, onT);
  W.po = initTimePicker('d-po', null, onT);
  W.srt = initTimePicker('d-srt', null, onT);
  W.line = initTimePicker('d-line', null, onT);
  bindNowButtons({ 'd-ll': W.ll, 'd-po': W.po, 'd-srt': W.srt, 'd-line': W.line });
  W.rem = $('#d-rem').kendoTextArea({ rows: 3, maxLength: 500, placeholder: 'What happened — delays, breakdowns, early completion, pilot late…', size: 'large', resize: 'vertical' }).data('kendoTextArea');
  $('#d-rem').on('input', () => setMsg('d-rem', ''));
  W.save = kButton('#d-save', { themeColor: 'primary' });
  W.save.bind('click', () => saveDeparture(r));
  evalDeparture(r);
}

function evalDeparture(r) {
  const t = { ll: readTime(W.ll), po: readTime(W.po), srt: readTime(W.srt), line: readTime(W.line) };
  let ok = true;
  Object.entries({ 'd-ll': t.ll, 'd-po': t.po, 'd-srt': t.srt, 'd-line': t.line }).forEach(([id, x]) => {
    if (x.bad) { setMsg(id, 'Enter time as HH:mm', 'error'); ok = false; } else setMsg(id, '');
  });
  if (t.ll.hm) {
    const dev = circDiff(r.predicted_last_lift_time, t.ll.hm);
    setMsg('d-ll', `${dev > 0 ? '+' : ''}${dev} min vs predicted ${esc(r.predicted_last_lift_time)}`, Math.abs(dev) <= 30 ? 'ok' : 'warn');
  }
  if (t.ll.hm && t.line.hm && circDiff(t.ll.hm, t.line.hm) < 0) {
    setMsg('d-line', '<i class="ti ti-alert-triangle"></i> Earlier than Actual Last Lift', 'error'); ok = false;
  }

  const box = $('#dep-result');
  const srtCls = t.ll.hm ? classifySRT(r.suggested_srt, t.ll.hm) : null;
  const winStart = toHM(addMin(hmToDate(r.suggested_srt), -TARGET.srtWindow));
  let html = `<div class="res-head">Departure result</div>`;

  // SRT compliance
  html += `<div class="res-block">
    <div class="res-row"><span>SRT compliance</span>${srtCls ? badge(srtCls) : '<span class="muted">needs last lift</span>'}</div>
    ${srtWindowViz(r.suggested_srt, t.ll.hm)}
    <div class="res-note">GOOD window ${winStart} – ${esc(r.suggested_srt)}</div>
  </div>`;

  if (t.ll.hm && t.line.hm && ok) {
    const qsail = circDiff(t.ll.hm, t.line.hm);
    const qsailCls = classify(qsail, TARGET.qsail);
    const idle = (+r.quick_start_minutes) + qsail;
    const idleCls = classify(idle, TARGET.idle);
    html += `<div class="res-block">
      <div class="res-row"><span>Quick Sail <em>Last Line − Last Lift</em></span><b>${qsail} min</b>${badge(qsailCls)}</div>
      ${gauge(qsail, TARGET.qsail)}
    </div>
    <div class="res-block">
      <div class="res-row"><span>Total Idle <em>QS ${esc(r.quick_start_minutes)} + QSail ${qsail}</em></span><b>${idle} min</b>${badge(idleCls)}</div>
      ${gauge(idle, TARGET.idle)}
    </div>`;
  } else if (!ok && t.line.hm) {
    html += `<div class="res-error"><i class="ti ti-alert-octagon"></i><div><b>Sequence error</b><br>Last Line (${t.line.hm}) is earlier than Last Lift (${t.ll.hm}).</div></div>`;
  } else {
    html += `<div class="res-empty sm"><i class="ti ti-hourglass-empty"></i><div>Enter Actual Last Lift and Last Line to see Quick Sail and Total Idle.</div></div>`;
  }
  box.html(html);

  const allSet = t.ll.hm && t.po.hm && t.srt.hm && t.line.hm;
  if (!ok || !allSet) return null;
  const qsail = circDiff(t.ll.hm, t.line.hm);
  const idle = (+r.quick_start_minutes) + qsail;
  return {
    ll: t.ll.hm, po: t.po.hm, srt: t.srt.hm, line: t.line.hm, winStart,
    srtCls, dev: circDiff(r.predicted_last_lift_time, t.ll.hm),
    qsail, qsailCls: classify(qsail, TARGET.qsail), idle, idleCls: classify(idle, TARGET.idle)
  };
}

function srtWindowViz(srt, ll) {
  // 60-minute axis: SRT-45 … SRT+15; window is SRT-15 … SRT
  const span = 60, startOff = -45;
  const pos = m => ((m - startOff) / span) * 100;
  let marker = '';
  if (ll) {
    const off = -circDiff(ll, srt);              // ll relative to srt (negative = before)
    const clamped = Math.max(startOff, Math.min(startOff + span, off));
    const good = off >= -TARGET.srtWindow && off <= 0;
    const p = pos(clamped);
    const label = (off < startOff ? '◂ ' : '') + ll + (off > startOff + span ? ' ▸' : '');
    marker = `<div class="win-mk ${good ? 'good' : 'bad'} ${p > 85 ? 'edge-r' : p < 15 ? 'edge-l' : ''}" style="left:${p}%"><span>${label}</span></div>`;
  }
  return `<div class="win">
    <div class="win-bar"><div class="win-good" style="left:${pos(-15)}%;width:${pos(0) - pos(-15)}%"></div></div>
    <div class="win-lbl" style="left:${pos(-15)}%">−15</div>
    <div class="win-lbl" style="left:${pos(0)}%">SRT</div>
    ${marker}
  </div>`;
}

async function saveDeparture(r) {
  const res = evalDeparture(r);
  const rem = String(W.rem.value() || '').trim();
  const errs = [];
  if (!res) {
    [['d-ll', W.ll], ['d-po', W.po], ['d-srt', W.srt], ['d-line', W.line]].forEach(([id, w]) => { if (!readTime(w).hm && !readTime(w).bad) setMsg(id, 'Required', 'error'); });
    errs.push('all four valid times');
  }
  if (!rem) { setMsg('d-rem', 'Remarks are mandatory', 'error'); errs.push('remarks'); }
  if (errs.length) { toast('Please complete: ' + errs.join(', '), 'warning'); return; }

  const upd = {
    actual_last_lift_time: res.ll, actual_pilot_onboard_time: res.po, actual_srt_time: res.srt,
    last_line_time: res.line, srt_window_start: res.winStart, srt_window_end: r.suggested_srt,
    srt_class: res.srtCls, deviation_minutes: res.dev,
    quick_sail_minutes: res.qsail, quick_sail_class: res.qsailCls,
    total_idle_minutes: res.idle, total_idle_class: res.idleCls,
    departure_remarks: rem, departure_operator: S.operator
  };
  setBusy(W.save, true);
  const ok = await dbUpdate(r.id, upd);
  setBusy(W.save, false);
  if (!ok) return;
  Object.assign(r, upd);
  updateNavCounts();
  S.depSel = null;
  toast(`Departure saved · ${r.vessel_name}`, 'success');
  openDialog({
    title: 'Vessel call completed',
    html: `<div class="dlg-sum">
      <div class="dlg-vessel"><i class="ti ti-ship"></i>${esc(r.vessel_name)} <span>· ${esc(r.vessel_reference)}</span></div>
      <div class="dlg-kv"><span>SRT compliance</span><b></b>${badge(upd.srt_class)}</div>
      <div class="dlg-kv"><span>Quick Start</span><b>${r.quick_start_minutes} min</b>${badge(r.quick_start_class)}</div>
      <div class="dlg-kv"><span>Quick Sail</span><b>${upd.quick_sail_minutes} min</b>${badge(upd.quick_sail_class)}</div>
      <div class="dlg-kv strong"><span>Total Idle</span><b>${upd.total_idle_minutes} min</b>${badge(upd.total_idle_class)}</div>
    </div>`,
    width: 420,
    actions: [
      { text: 'View records', action: () => { go('records'); return true; } },
      { text: 'Open dashboard', primary: true, action: () => { go('dashboard'); return true; } }
    ]
  });
  renderView();
}

// ── RECORDS ───────────────────────────────────────────────
function filteredRecords() {
  const q = S.recSearch.trim().toLowerCase();
  return S.records.filter(r =>
    (S.recFilter === 'all' || phaseOf(r) === S.recFilter) &&
    (!q || [r.vessel_name, r.vessel_reference, r.operator_id, r.qc_number].some(x => String(x || '').toLowerCase().includes(q))));
}
function updateFilterCounts() {
  const c = { all: S.records.length, arrival: 0, prediction: 0, completed: 0 };
  S.records.forEach(r => c[phaseOf(r)]++);
  Object.keys(c).forEach(k => $(`[data-fc="${k}"]`).text(c[k]));
}

function renderRecords(v) {
  v.html(`
  <section class="card toolbar-card">
    <div class="rec-tools">
      <div class="rec-search"><input id="r-search" /></div>
      <div id="r-filter"></div>
    </div>
  </section>
  <section class="card list-card">
    <div id="r-list" class="rec-list"></div>
    <div id="r-pager"></div>
  </section>`);

  W.search = $('#r-search').kendoTextBox({ placeholder: 'Search vessel, reference, operator, QC…', size: 'large', value: S.recSearch, clearButton: true, prefixOptions: { icon: 'search' } }).data('kendoTextBox');
  let tmr;
  $('#r-search').on('input', function () { clearTimeout(tmr); tmr = setTimeout(() => { S.recSearch = this.value; W.recDS.data(filteredRecords()); }, 150); });
  W.search.bind('change', function () { S.recSearch = this.value() || ''; W.recDS.data(filteredRecords()); });

  const filters = [['all', 'All'], ['arrival', 'Predict'], ['prediction', 'Depart'], ['completed', 'Done']];
  W.filter = $('#r-filter').kendoButtonGroup({
    size: 'large',
    items: filters.map(([k, l]) => ({ text: l, attributes: { 'data-f': k }, selected: S.recFilter === k })),
    select(e) { S.recFilter = filters[e.indices[0]][0]; W.recDS.data(filteredRecords()); }
  }).data('kendoButtonGroup');
  $('#r-filter .k-button').each(function (i) {
    $(this).find('.k-button-text').append(` <span class="fc" data-fc="${filters[i][0]}"></span>`);
  });
  updateFilterCounts();

  W.recDS = new kendo.data.DataSource({ data: filteredRecords(), pageSize: 12 });
  W.list = $('#r-list').kendoListView({
    dataSource: W.recDS,
    selectable: false,
    template: r => recordRow(r),
    dataBound() {
      if (!this.dataSource.total()) this.element.html(emptyState('ti-search', 'No matching records', S.records.length ? 'Try a different search or filter.' : 'Records appear here once an arrival is saved.'));
    }
  }).data('kendoListView');
  W.pager = $('#r-pager').kendoPager({ dataSource: W.recDS, responsive: true, buttonCount: 5, info: true, messages: { display: '{0}–{1} of {2} records', empty: '' } }).data('kendoPager');

  v.on('click', '.rec-row', function () {
    const r = S.records.find(x => x.id === this.getAttribute('data-id'));
    if (r) openRecord(r);
  });
}

function recordRow(r) {
  const ph = phaseOf(r);
  const chips = [];
  if (r.quick_start_minutes != null) chips.push(miniChip('QS', r.quick_start_minutes, r.quick_start_class));
  if (r.suggested_srt) chips.push(`<span class="mchip"><em>SRT</em>${esc(r.suggested_srt)}</span>`);
  if (ph === 'completed') {
    chips.push(miniChip('QSail', r.quick_sail_minutes, r.quick_sail_class));
    chips.push(miniChip('Idle', r.total_idle_minutes, r.total_idle_class));
  }
  return `<div class="rec-row" data-id="${esc(r.id)}" role="button" tabindex="0">
    <div class="rec-ic ${PHASES[ph].cls}"><i class="ti ${ph === 'completed' ? 'ti-circle-check' : 'ti-ship'}"></i></div>
    <div class="rec-main">
      <div class="rec-top"><span class="rec-name">${esc(r.vessel_name)}</span><span class="rec-ref">${esc(r.vessel_reference)}</span></div>
      <div class="rec-meta"><i class="ti ti-calendar"></i>${esc(fmtDateTime(r.created_at))}<i class="ti ti-user"></i>${esc(r.operator_id)}</div>
      <div class="rec-chips">${chips.join('')}</div>
    </div>
    <div class="rec-side">${phasePill(r)}${ph === 'completed' ? `<span class="rec-srt">${badge(r.srt_class, 'SRT ' + (r.srt_class === 'GOOD' ? 'GOOD' : 'NQ'))}</span>` : ''}<i class="ti ti-chevron-right rec-chev"></i></div>
  </div>`;
}
const miniChip = (k, v, cls) => `<span class="mchip ${cls === 'GOOD' ? 'good' : 'bad'}"><em>${k}</em>${esc(v)}m</span>`;

function openRecord(r) {
  const ph = phaseOf(r);
  const row = (k, v, extra) => `<div class="d-row"><span>${k}</span><b>${v == null || v === '' ? '—' : esc(v)}</b>${extra || ''}</div>`;
  const remark = t => t ? `<div class="d-rem"><i class="ti ti-message-2"></i>${esc(t)}</div>` : '';
  let html = `<div class="detail">
    <div class="d-head"><div><div class="d-name">${esc(r.vessel_name)}</div><div class="d-sub">${esc(r.vessel_reference)} · ${esc(fmtDateTime(r.created_at))}</div></div>${phasePill(r)}</div>
    <div class="d-sec"><div class="d-sec-t"><span class="dot">1</span>Arrival <em>by ${esc(r.operator_id)}</em></div>
      ${row('First line', r.first_line_time)}${row('Vessel secured (RTW)', r.rtw_time)}${row('First lift', r.first_lift_time)}
      ${row('Quick Start', r.quick_start_minutes + ' min', badge(r.quick_start_class))}
      ${remark(r.arrival_remarks)}
    </div>`;
  if (r.predicted_last_lift_time) {
    html += `<div class="d-sec"><div class="d-sec-t"><span class="dot">2</span>Departure prediction <em>by ${esc(r.prediction_operator || '—')}</em></div>
      ${row('QC · model', `${r.qc_number} · ${r.qc_model || '—'}`)}${row('CMPH', r.cmph)}
      ${row('Total operation time', (+r.total_min).toFixed(1) + ' min')}
      ${row('Predicted last lift', r.predicted_last_lift_time)}${row('Recommended SRT', r.suggested_srt)}
      ${remark(r.prediction_remarks)}
    </div>`;
  }
  if (r.actual_last_lift_time) {
    html += `<div class="d-sec"><div class="d-sec-t"><span class="dot">3</span>Actual departure <em>by ${esc(r.departure_operator || '—')}</em></div>
      ${row('Actual last lift', r.actual_last_lift_time)}${row('Pilot onboard', r.actual_pilot_onboard_time)}
      ${row('Actual SRT', r.actual_srt_time)}${row('Last line', r.last_line_time)}
      ${row('SRT window', `${r.srt_window_start} – ${r.srt_window_end}`, badge(r.srt_class))}
      ${row('LL deviation (actual − predicted)', `${r.deviation_minutes > 0 ? '+' : ''}${r.deviation_minutes} min`)}
      ${row('Quick Sail', r.quick_sail_minutes + ' min', badge(r.quick_sail_class))}
      ${row('Total Idle', r.total_idle_minutes + ' min', badge(r.total_idle_class))}
      ${remark(r.departure_remarks)}
    </div>`;
  }
  html += '</div>';
  const actions = [{ text: 'Close' }];
  if (ph === 'arrival') actions.push({ text: 'Continue to prediction', primary: true, action: () => { go('prediction', { predSel: r.id }); return true; } });
  if (ph === 'prediction') actions.push({ text: 'Continue to departure', primary: true, action: () => { go('departure', { depSel: r.id }); return true; } });
  openDialog({ title: 'Vessel call', html, actions, width: 560 });
}

// ── DASHBOARD ─────────────────────────────────────────────
function dashBase() {
  let base = S.records;
  if (S.monthFilter !== 'all') base = base.filter(r => getMonthKey(new Date(r.created_at)) === S.monthFilter);
  if (S.weekFilter !== 'all') base = base.filter(r => getWeekKey(new Date(r.created_at)) === S.weekFilter);
  return base;
}

function metricSet(base) {
  const done = base.filter(r => r.actual_last_lift_time);
  const m = (list, clsKey, minKey) => {
    const all = list.filter(r => r[clsKey]);
    const good = all.filter(r => r[clsKey] === 'GOOD').length;
    const vals = minKey ? all.map(r => +r[minKey]).filter(n => !isNaN(n)) : [];
    return { good, total: all.length, rate: all.length ? Math.round(good / all.length * 100) : null, avg: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null };
  };
  return {
    done,
    srt: m(done, 'srt_class'),
    idle: m(done, 'total_idle_class', 'total_idle_minutes'),
    qs: m(base, 'quick_start_class', 'quick_start_minutes'),
    qsail: m(done, 'quick_sail_class', 'quick_sail_minutes')
  };
}

function renderDashboard(v) {
  const monthKeys = [...new Set(S.records.map(r => getMonthKey(new Date(r.created_at))))].sort().reverse();
  const weekKeys = [...new Set(S.records
    .filter(r => S.monthFilter === 'all' || getMonthKey(new Date(r.created_at)) === S.monthFilter)
    .map(r => getWeekKey(new Date(r.created_at))))].sort().reverse();
  if (S.weekFilter !== 'all' && !weekKeys.includes(S.weekFilter)) S.weekFilter = 'all';

  const base = dashBase();
  const M = metricSet(base);
  const inProg = base.filter(r => phaseOf(r) !== 'completed').length;

  v.html(`
  <section class="card toolbar-card">
    <div class="dash-tools">
      <div class="fld"><label class="k-label fld-label" for="f-month">Month</label><input id="f-month" /></div>
      <div class="fld"><label class="k-label fld-label" for="f-week">Workweek (Mon–Sun)</label><input id="f-week" /></div>
      <div class="dash-act">
        <button id="f-reset" class="link-btn" ${S.monthFilter === 'all' && S.weekFilter === 'all' ? 'hidden' : ''}><i class="ti ti-filter-off"></i> Reset</button>
        <button id="csv-btn"><i class="ti ti-file-spreadsheet"></i>&nbsp;Export CSV</button>
      </div>
    </div>
  </section>

  <div class="summary">
    <div><span>Vessel calls</span><b>${base.length}</b></div>
    <div><span>Completed</span><b>${M.done.length}</b></div>
    <div><span>In progress</span><b>${inProg}</b></div>
    <div><span>Avg total idle</span><b>${M.idle.avg != null ? M.idle.avg + '<small>min</small>' : '—'}</b></div>
  </div>

  <div class="donuts">
    ${donutCard('ch-srt', 'SRT compliance', M.srt, 'Last lift within SRT −15 → SRT', null, true)}
    ${donutCard('ch-idle', 'Total idle', M.idle, `Quick Start + Quick Sail ≤ ${TARGET.idle} min`, TARGET.idle, true)}
    ${donutCard('ch-qs', 'Quick Start', M.qs, `First Lift − RTW ≤ ${TARGET.qs} min`, TARGET.qs)}
    ${donutCard('ch-qsail', 'Quick Sail', M.qsail, `Last Line − Last Lift ≤ ${TARGET.qsail} min`, TARGET.qsail)}
  </div>

  ${!M.done.length ? `<section class="card">${emptyState('ti-chart-bar', 'No completed vessel calls in this period', 'Charts and the records table fill in once departures are recorded.')}</section>` : `
  <div class="charts2">
    <section class="card">
      <h2 class="card-t"><i class="ti ti-chart-bar"></i>Quick Start vs Quick Sail <span class="card-hint">last 10 completed</span></h2>
      <div class="chart-box"><canvas id="ch-bar" role="img" aria-label="Quick Start and Quick Sail minutes for the last ten completed vessels"></canvas></div>
    </section>
    <section class="card">
      <h2 class="card-t"><i class="ti ti-trending-up"></i>Weekly GOOD rate</h2>
      <div class="chart-box"><canvas id="ch-trend" role="img" aria-label="Weekly SRT compliance and total idle GOOD rate"></canvas></div>
    </section>
  </div>
  <section class="card">
    <h2 class="card-t"><i class="ti ti-table"></i>Recent completed <span class="card-hint">latest 30 · tap a row for detail</span></h2>
    <div class="table-wrap">
      <table class="k-table k-table-md dash-table">
        <thead class="k-table-thead"><tr class="k-table-row">
          <th class="k-table-th">Date</th><th class="k-table-th">Vessel</th><th class="k-table-th">QC</th>
          <th class="k-table-th num">Q.Start</th><th class="k-table-th num">Q.Sail</th><th class="k-table-th num">Idle</th><th class="k-table-th">SRT</th>
        </tr></thead>
        <tbody class="k-table-tbody">${M.done.slice(0, 30).map(r => `<tr class="k-table-row" data-id="${esc(r.id)}">
          <td class="k-table-td mono">${esc(new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }))}</td>
          <td class="k-table-td"><b>${esc(r.vessel_name)}</b><div class="muted sm">${esc(r.vessel_reference)}</div></td>
          <td class="k-table-td">${esc(r.qc_number || '—')}</td>
          <td class="k-table-td num">${miniChip('', r.quick_start_minutes, r.quick_start_class)}</td>
          <td class="k-table-td num">${miniChip('', r.quick_sail_minutes, r.quick_sail_class)}</td>
          <td class="k-table-td num">${miniChip('', r.total_idle_minutes, r.total_idle_class)}</td>
          <td class="k-table-td">${badge(r.srt_class, r.srt_class === 'GOOD' ? 'GOOD' : 'NQ')}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
  </section>`}`);

  W.month = $('#f-month').kendoDropDownList({
    dataSource: [{ v: 'all', t: 'All months' }].concat(monthKeys.map(k => ({ v: k, t: monthLabel(k) }))),
    dataTextField: 't', dataValueField: 'v', value: S.monthFilter, size: 'large',
    change() { S.monthFilter = this.value(); S.weekFilter = 'all'; renderView(); }
  }).data('kendoDropDownList');
  W.week = $('#f-week').kendoDropDownList({
    dataSource: [{ v: 'all', t: 'All weeks' }].concat(weekKeys.map(k => ({ v: k, t: weekLabel(k) }))),
    dataTextField: 't', dataValueField: 'v', value: S.weekFilter, size: 'large',
    change() { S.weekFilter = this.value(); renderView(); }
  }).data('kendoDropDownList');
  $('#f-reset').on('click', () => { S.monthFilter = 'all'; S.weekFilter = 'all'; renderView(); });
  kButton('#csv-btn', { themeColor: 'primary', fillMode: 'outline' }).bind('click', downloadReport);
  v.on('click', '.dash-table tbody tr', function () { const r = S.records.find(x => x.id === this.getAttribute('data-id')); if (r) openRecord(r); });

  requestAnimationFrame(() => drawDashCharts(M));
}

function donutCard(id, title, m, rule, target, primary) {
  const rate = m.rate;
  const tone = rate == null ? 'na' : rate >= TARGET.rate ? 'good' : rate >= 60 ? 'mid' : 'bad';
  return `<section class="card donut-card ${primary ? 'primary' : ''}">
    <div class="dc-head"><span class="dc-t">${title}</span>${primary ? '<span class="dc-key">Key metric</span>' : ''}</div>
    <div class="dc-body">
      <div class="dc-ring"><canvas id="${id}" role="img" aria-label="${title}: ${rate == null ? 'no data' : rate + '% GOOD'}"></canvas>
        <div class="dc-center"><b class="tone-${tone}">${rate == null ? '—' : rate + '%'}</b><span>target ${TARGET.rate}%</span></div>
      </div>
      <div class="dc-stats">
        <div><span>GOOD</span><b>${m.good}<small>/${m.total}</small></b></div>
        ${target != null ? `<div><span>Average</span><b>${m.avg != null ? m.avg : '—'}<small>${m.avg != null ? ' min' : ''}</small></b></div>` : ''}
        <div class="dc-rule">${rule}</div>
      </div>
    </div>
  </section>`;
}

function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function drawDashCharts(M) {
  if (!window.Chart) return;
  const cGood = cssVar('--good') || '#1F8A5B', cBad = cssVar('--bad') || '#D64545', cTrack = cssVar('--track') || '#E7EAEE';
  const cBlue = cssVar('--brand') || '#185FA5', cOrange = cssVar('--accent') || '#E8830C', cMuted = cssVar('--muted') || '#667085', cGrid = cssVar('--grid') || 'rgba(0,0,0,.06)';
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = cMuted;

  const donut = (id, m) => {
    const el = document.getElementById(id); if (!el) return;
    const empty = !m.total;
    charts.push(new Chart(el, {
      type: 'doughnut',
      data: { labels: ['GOOD', 'NOT QUALITY'], datasets: [{ data: empty ? [1] : [m.good, m.total - m.good], backgroundColor: empty ? [cTrack] : [cGood, cBad], borderWidth: 0, borderRadius: empty ? 0 : 4, spacing: empty || !m.good || m.good === m.total ? 0 : 2 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '74%', animation: { duration: 500 }, plugins: { legend: { display: false }, tooltip: { enabled: !empty } } }
    }));
  };
  donut('ch-srt', M.srt); donut('ch-idle', M.idle); donut('ch-qs', M.qs); donut('ch-qsail', M.qsail);

  const bar = document.getElementById('ch-bar');
  if (bar) {
    const last10 = M.done.slice(0, 10).reverse();
    charts.push(new Chart(bar, {
      type: 'bar',
      data: {
        labels: last10.map(r => r.vessel_name.length > 10 ? r.vessel_name.slice(0, 9) + '…' : r.vessel_name),
        datasets: [
          { label: 'Quick Start', data: last10.map(r => r.quick_start_minutes), backgroundColor: cBlue, borderRadius: 4, maxBarThickness: 22 },
          { label: 'Quick Sail', data: last10.map(r => r.quick_sail_minutes), backgroundColor: cOrange, borderRadius: 4, maxBarThickness: 22 },
          { type: 'line', label: `QS target ${TARGET.qs}`, data: last10.map(() => TARGET.qs), borderColor: cBlue, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0 },
          { type: 'line', label: `QSail target ${TARGET.qsail}`, data: last10.map(() => TARGET.qsail), borderColor: cOrange, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { size: 11 } } },
          tooltip: { callbacks: { title: items => last10[items[0].dataIndex].vessel_name + ' · ' + last10[items[0].dataIndex].vessel_reference, label: c => c.dataset.type === 'line' ? null : `${c.dataset.label}: ${c.parsed.y} min` } } },
        scales: { y: { beginAtZero: true, grid: { color: cGrid }, border: { display: false }, title: { display: true, text: 'Minutes', font: { size: 11 } } }, x: { grid: { display: false }, ticks: { maxRotation: 40, font: { size: 10 } } } }
      }
    }));
  }

  const tr = document.getElementById('ch-trend');
  if (tr) {
    const byWeek = {};
    M.done.forEach(r => { const k = getWeekKey(new Date(r.created_at)); (byWeek[k] = byWeek[k] || []).push(r); });
    const keys = Object.keys(byWeek).sort().slice(-12);
    const rate = (list, key) => Math.round(list.filter(r => r[key] === 'GOOD').length / list.length * 100);
    charts.push(new Chart(tr, {
      type: 'line',
      data: {
        labels: keys.map(k => k.split('-')[1]),
        datasets: [
          { label: 'SRT compliance', data: keys.map(k => rate(byWeek[k], 'srt_class')), borderColor: cBlue, backgroundColor: cBlue, tension: .3, pointRadius: 3.5, borderWidth: 2 },
          { label: 'Total idle', data: keys.map(k => rate(byWeek[k], 'total_idle_class')), borderColor: cGood, backgroundColor: cGood, tension: .3, pointRadius: 3.5, borderWidth: 2 },
          { label: `Target ${TARGET.rate}%`, data: keys.map(() => TARGET.rate), borderColor: cMuted, borderDash: [5, 4], borderWidth: 1.2, pointRadius: 0 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { size: 11 } } },
          tooltip: { callbacks: { title: i => weekLabel(keys[i[0].dataIndex]) + ` · ${byWeek[keys[i[0].dataIndex]].length} calls`, label: c => `${c.dataset.label}: ${c.parsed.y}%` } } },
        scales: { y: { min: 0, max: 100, grid: { color: cGrid }, border: { display: false }, ticks: { callback: v => v + '%', stepSize: 25 } }, x: { grid: { display: false } } }
      }
    }));
  }
}

// ── CSV EXPORT ────────────────────────────────────────────
function downloadReport() {
  const done = dashBase().filter(r => r.actual_last_lift_time);
  if (!done.length) { toast('No completed records to export for the selected filter.', 'warning'); return; }
  const cols = [
    ['id', 'ID'], ['created_at', 'Created At', v => v ? new Date(v).toLocaleString('en-GB') : ''], ['operator_id', 'Operator ID'],
    ['vessel_name', 'Vessel Name'], ['vessel_reference', 'Vessel Reference'],
    ['first_line_time', 'First Line Time'], ['rtw_time', 'RTW Time'], ['first_lift_time', 'First Lift Time'],
    ['quick_start_minutes', 'Quick Start (min)'], ['quick_start_class', 'Quick Start Class'], ['arrival_remarks', 'Arrival Remarks'],
    ['qc_number', 'QC Number'], ['qc_model', 'QC Model'], ['qc_speed', 'QC Speed (m/min)'], ['cmph', 'CMPH'],
    ['f1', 'Normal Container (Unit)'], ['f2', 'Twin Lift (Unit)'], ['f3', 'Gearbox (Unit)'], ['f4', 'Hatch Cover (Unit)'],
    ['f5', 'OOG (Unit)'], ['f6', 'Open Top (Unit)'], ['f7', 'Gantry Movement (Bay)'], ['f8', 'Breakdown (Min)'],
    ['container_min', 'Container Work Time (min)'], ['gantry_min', 'Gantry Travel Time (min)'], ['buffer_min', 'Breakdown Buffer (min)'],
    ['total_min', 'Total Operation Time (min)'], ['predicted_last_lift_time', 'Predicted Last Lift'], ['suggested_srt', 'Suggested SRT'],
    ['prediction_remarks', 'Prediction Remarks'], ['prediction_operator', 'Prediction Operator'],
    ['actual_last_lift_time', 'Actual Last Lift'], ['actual_pilot_onboard_time', 'Pilot Onboard'], ['actual_srt_time', 'Actual SRT'],
    ['last_line_time', 'Last Line Time'], ['srt_window_start', 'SRT Window Start'], ['srt_window_end', 'SRT Window End'],
    ['srt_class', 'SRT Class'], ['deviation_minutes', 'LL Deviation (min)'], ['quick_sail_minutes', 'Quick Sail (min)'],
    ['quick_sail_class', 'Quick Sail Class'], ['total_idle_minutes', 'Total Idle (min)'], ['total_idle_class', 'Total Idle Class'],
    ['departure_remarks', 'Departure Remarks'], ['departure_operator', 'Departure Operator']
  ];
  const cell = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [cols.map(c => cell(c[1])).join(',')]
    .concat(done.map(r => cols.map(c => cell(c[2] ? c[2](r[c[0]]) : r[c[0]])).join(',')))
    .join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const tag = S.weekFilter !== 'all' ? '_' + S.weekFilter : S.monthFilter !== 'all' ? '_' + S.monthFilter : '';
  a.href = url; a.download = `VSR_Report${tag}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${done.length} completed record${done.length > 1 ? 's' : ''}`, 'success');
}

// ── BOOT ──────────────────────────────────────────────────
(function boot(tries) {
  if (window.jQuery && window.kendo && window.sb) {
    loadQCDatabase().then(() => {
      renderRoot();
      if (S.operator) loadRecords().then(() => refreshCurrentLists());
    });
  } else if ((tries || 0) > 100) {
    document.getElementById('root').innerHTML = '<div class="boot"><div class="boot-text">Could not load app libraries. Check your connection and reload.</div></div>';
  } else {
    setTimeout(() => boot((tries || 0) + 1), 100);
  }
})();

// expose for debugging
window.VSR = { S, circDiff, classifySRT, roundUpTo15, calcPrediction };
})();
