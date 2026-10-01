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
  arrDraft: { vessel: '', reference: '', fl: null, rtw: null, fli: null, remarks: '', dates: null },
  predSel: store.get('ptp_predSel') || null,
  predDraft: { qc: '', cmph: null, f1: 0, f2: 0, f3: 0, f4: 0, f5: 0, f6: 0, f7: 0, f8: 0, remarks: '' },
  predDrafts: {},     // { recordId: prediction draft } — one per vessel
  depSel: store.get('ptp_depSel') || null,
  depDraft: {},       // { recordId: { ll, po, srt, line, rem, dates } } — survives tab switches
  recFilter: 'all',
  recSearch: '',
  monthFilter: 'all',
  weekFilter: 'all'
};
// ── DRAFTS ON THIS DEVICE ─────────────────────────────────
// Everything typed (all three phases, per vessel) is saved to the phone/PC's local storage as you type,
// so closing the browser/app, a dropped connection, a reload or switching tabs never loses entries.
// Drafts are kept per employee ID and cleared when that record is saved.
const emptyArr = () => ({ vessel: '', reference: '', fl: null, rtw: null, fli: null, remarks: '', dates: null });
const emptyPred = () => ({ qc: '', cmph: null, f1: 0, f2: 0, f3: 0, f4: 0, f5: 0, f6: 0, f7: 0, f8: 0, remarks: '' });
const draftKey = () => 'ptp_drafts_' + (S.operator || '_');
let draftTimer = null;
function saveDrafts(now) {
  clearTimeout(draftTimer);
  const run = () => {
    if (!S.operator) return;
    const clean = o => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v && hasContent(v)));
    const data = { v: 1, at: Date.now(), arr: hasContent(S.arrDraft) ? S.arrDraft : null, pred: clean(S.predDrafts), dep: clean(S.depDraft) };
    if (!data.arr && !Object.keys(data.pred).length && !Object.keys(data.dep).length) store.del(draftKey());
    else store.set(draftKey(), JSON.stringify(data));
    store.set('ptp_predSel', S.predSel || ''); store.set('ptp_depSel', S.depSel || '');
    $('.draft-note').html(`<i class="ti ti-device-floppy"></i>Draft kept on this device · ${toHM(new Date())}`).addClass('on');
  };
  if (now) run(); else draftTimer = setTimeout(run, 400);
}
function hasContent(d) {
  return d && Object.entries(d).some(([k, v]) => k !== 'dates' && v !== null && v !== '' && v !== 0 && v !== undefined);
}
function loadDrafts() {
  let data = null;
  try { data = JSON.parse(store.get(draftKey()) || 'null'); } catch (e) { data = null; }
  if (!data || data.v !== 1 || Date.now() - data.at > 7 * 86400000) return false;   // ignore drafts older than a week
  // Pin every restored date so a draft reopened tomorrow keeps the dates it was typed with
  // (only fields that already have a time; empty fields stay automatic)
  const FIELD = { 'a-fl': 'fl', 'a-rtw': 'rtw', 'a-fli': 'fli', 'd-ll': 'll', 'd-po': 'po', 'd-srt': 'srt', 'd-line': 'line' };
  const pin = o => { if (o && o.dates) Object.entries(o.dates).forEach(([id, d]) => { d.manual = !!o[FIELD[id]] || d.manual; }); return o; };
  if (data.arr) S.arrDraft = Object.assign(emptyArr(), pin(data.arr));
  S.predDrafts = data.pred || {};
  S.depDraft = {};
  Object.entries(data.dep || {}).forEach(([id, d]) => { S.depDraft[id] = pin(d); });
  return hasContent(S.arrDraft) || Object.keys(S.predDrafts).length > 0 || Object.keys(S.depDraft).length > 0;
}
/** Drop drafts whose vessel has already moved past that phase (e.g. saved on another phone) */
function pruneDrafts() {
  if (!S.loaded) return;
  Object.keys(S.predDrafts).forEach(id => { const r = S.records.find(x => x.id === id); if (!r || phaseOf(r) !== 'arrival') delete S.predDrafts[id]; });
  Object.keys(S.depDraft).forEach(id => { const r = S.records.find(x => x.id === id); if (!r || phaseOf(r) !== 'prediction') delete S.depDraft[id]; });
  saveDrafts(true);
}
const draftNote = () => '<div class="draft-note" aria-live="polite"></div>';
$(document).on('visibilitychange', () => { if (document.visibilityState === 'hidden') saveDrafts(true); });
$(window).on('pagehide beforeunload', () => saveDrafts(true));

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

// ── DATE-AWARE TIMES ───────────────────────────────────────
// Every time field carries a calendar date, saved to the *_at (timestamptz) columns.
//  • First field of a group: today (or yesterday if the time would be > 60 min in the future).
//  • Later fields: the date that puts the time nearest the previous field (±12 h), so
//    23:55 → 00:05 rolls to the next day, while RTW 10:10 → First Lift 10:04 stays the same day.
//  • A date the operator picks by hand is never auto-changed again ("Back to auto" undoes it).
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const shiftYmd = (s, n) => { const d = new Date(s + 'T12:00'); d.setDate(d.getDate() + n); return ymd(d); };
const mkDT = (ds, hm) => new Date(ds + 'T' + hm);
const diffMin = (a, b) => Math.round((b - a) / 60000);             // b − a in minutes (Dates)
const fmtDay = s => { const d = new Date(s + 'T12:00'); return WD[d.getDay()] + ' ' + d.getDate() + ' ' + MO[d.getMonth()]; };
/** "HH:mm" plus " · 1 Oct" when the date isn't today */
const fmtAt = d => toHM(d) + (ymd(d) === ymd(new Date()) ? '' : ' · ' + d.getDate() + ' ' + MO[d.getMonth()]);
/** Always "HH:mm · 1 Oct" */
const fmtDT = d => toHM(d) + ' · ' + d.getDate() + ' ' + MO[d.getMonth()];

function nearestDate(hm, anchor) {
  const base = ymd(anchor);
  let best = base, gap = Infinity;
  [-1, 0, 1].forEach(k => { const d = shiftYmd(base, k); const g = Math.abs(mkDT(d, hm) - anchor); if (g < gap) { gap = g; best = d; } });
  return best;
}
/** Date-time of a stored record field; legacy rows (no *_at) are placed nearest an anchor */
function recAt(r, atKey, hmKey, anchor) {
  if (r[atKey]) return new Date(r[atKey]);
  if (!r[hmKey]) return null;
  const a = anchor || new Date(r.created_at);
  return mkDT(nearestDate(r[hmKey], a), r[hmKey]);
}
/** Display a stored time with its date (falls back to HH:mm for legacy rows) */
const showAt = (r, atKey, hmKey) => r[atKey] ? fmtAt(new Date(r[atKey])) : (r[hmKey] || '');

const DT_GROUPS = { arr: ['a-fl', 'a-rtw', 'a-fli'], dep: ['d-ll', 'd-po', 'd-srt', 'd-line'] };
let DT = {};        // { fieldId: { date:'YYYY-MM-DD', manual:bool } }
let DTW = {};       // { fieldId: kendoTimePicker }
const groupOf = id => Object.keys(DT_GROUPS).find(g => DT_GROUPS[g].includes(id));

function initDTGroup(g, saved) {
  DT_GROUPS[g].forEach(id => { DT[id] = saved && saved[id] ? Object.assign({}, saved[id]) : { date: ymd(new Date()), manual: false }; });
}
function dtSync(g) {
  let anchor = null;
  DT_GROUPS[g].forEach(id => {
    const st = DT[id] || (DT[id] = { date: ymd(new Date()), manual: false });
    const hm = DTW[id] ? readTime(DTW[id]).hm : null;
    if (!st.manual) {
      const prev = st.date;
      if (hm && anchor) st.date = nearestDate(hm, anchor);
      else if (hm) { const t = ymd(new Date()); st.date = (mkDT(t, hm) - new Date() > 60 * 60000) ? shiftYmd(t, -1) : t; }
      else st.date = anchor ? ymd(anchor) : ymd(new Date());
      if (prev !== st.date) st.flash = true;
    }
    if (hm) anchor = mkDT(st.date, hm);
  });
  DT_GROUPS[g].forEach(paintChip);
  const snap = JSON.parse(JSON.stringify(DT_GROUPS[g].reduce((o, id) => (o[id] = { date: DT[id].date, manual: DT[id].manual }, o), {})));
  if (g === 'arr') S.arrDraft.dates = snap;
  saveDrafts();
  if (g === 'dep' && W.depRec && S.depDraft[W.depRec.id]) {
    const dd = S.depDraft[W.depRec.id];
    dd.dates = snap;
    ['ll', 'po', 'srt', 'line'].forEach((k, i) => { const t = DTW[DT_GROUPS.dep[i]] ? readTime(DTW[DT_GROUPS.dep[i]]).hm : null; dd[k] = t; });
  }
}
function paintChip(id) {
  const el = document.getElementById(id + '-dc'); const st = DT[id];
  if (!el || !st) return;
  const first = DT_GROUPS[groupOf(id)][0];
  const delta = Math.round((new Date(st.date + 'T12:00') - new Date(DT[first].date + 'T12:00')) / 86400000);
  const shifted = delta !== 0 && id !== first;
  el.innerHTML = `<i class="ti ti-calendar"></i>${fmtDay(st.date)}${shifted ? `<span class="dchip-d">${delta > 0 ? '+' : ''}${delta}d</span>` : ''}${st.manual ? '<i class="ti ti-pin dchip-pin"></i>' : ''}`;
  el.classList.toggle('shifted', shifted);
  el.title = st.manual ? 'Date set manually — tap to change' : 'Date filled automatically — tap to change';
  if (st.flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); st.flash = false; }
}
function readDT(id) {
  const hm = DTW[id] ? readTime(DTW[id]).hm : null;
  if (!hm) return null;
  const date = (DT[id] && DT[id].date) || ymd(new Date());
  return { hm, date, dt: mkDT(date, hm) };
}
// Date chip popover: Yesterday / Today / Tomorrow / Pick date…
function openDatePop(id, chip) {
  closeDatePop();
  const today = ymd(new Date());
  const opts = [['Yesterday', shiftYmd(today, -1)], ['Today', today], ['Tomorrow', shiftYmd(today, 1)]];
  const pop = $(`<div class="dpop" id="dpop" role="menu">
    ${opts.map(([l, d]) => `<button type="button" data-d="${d}" class="${DT[id].date === d ? 'on' : ''}">${l}<span>${fmtDay(d)}</span></button>`).join('')}
    <label class="dpop-pick"><i class="ti ti-calendar-search"></i>Pick date…<input type="date" value="${DT[id].date}"></label>
    ${DT[id].manual ? '<button type="button" class="dpop-auto" data-auto="1"><i class="ti ti-wand"></i>Back to auto</button>' : ''}
  </div>`).appendTo(document.body);
  const set = d => { DT[id].date = d; DT[id].manual = true; closeDatePop(); dtSync(groupOf(id)); onDTChange(groupOf(id)); };
  pop.on('click', '[data-d]', function () { set(this.getAttribute('data-d')); });
  pop.on('click', '[data-auto]', () => { DT[id].manual = false; closeDatePop(); dtSync(groupOf(id)); onDTChange(groupOf(id)); });
  pop.find('input').on('click', function () { try { this.showPicker(); } catch (e) {} }).on('change', function () { if (this.value) set(this.value); });
  const r = chip.getBoundingClientRect(), w = pop.outerWidth();
  pop.css({ top: window.scrollY + r.bottom + 4, left: Math.max(8, Math.min(window.scrollX + r.right - w, window.scrollX + document.documentElement.clientWidth - w - 8)) });
}
function closeDatePop() { $('#dpop').remove(); }
$(document).on('click.dpop', e => { if (!$(e.target).closest('#dpop, .dchip').length) closeDatePop(); });
$(window).on('resize.dpop', closeDatePop);
/** Re-evaluate the current form after a date change */
function onDTChange(g) { if (g === 'arr') evalArrival(); else if (g === 'dep' && W.depRec) evalDeparture(W.depRec); }

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
function openDialog({ title, html, actions, width, maxHeight, cls }) {
  const $d = $(`<div class="vsr-dialog ${cls || ''}"></div>`).appendTo(document.body);
  const dlg = $d.kendoDialog({
    title: title || false,
    content: html,
    width: (width || 520) + 'px',
    maxHeight: maxHeight || Math.round(window.innerHeight * 0.9),
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

/** Forces upper-case while typing without jumping the caret */
function upperInput(el) {
  const s = el.selectionStart, e = el.selectionEnd, u = el.value.toUpperCase();
  if (u !== el.value) { el.value = u; try { el.setSelectionRange(s, e); } catch (x) {} }
  return u;
}

/** Run fn after a dropdown popup has finished closing (safe to re-render / destroy it then) */
function afterPopup(w, fn) {
  const pop = w && w.popup;
  if (pop && pop.visible()) pop.one('deactivate', () => setTimeout(fn, 0));
  else setTimeout(fn, 0);
}

/** Confirmation dialog building blocks */
const cfKV = (k, v, extra, strong) => `<div class="dlg-kv${strong ? ' strong' : ''}"><span>${k}</span>${v === '' ? '' : `<b>${v == null ? '—' : v}</b>`}${extra || ''}</div>`;
const cfSec = t => `<div class="cf-sec">${t}</div>`;
const cfRem = t => t ? `<div class="d-rem"><i class="ti ti-message-2"></i>${esc(t)}</div>` : '<div class="d-rem muted"><i class="ti ti-message-2"></i>No remarks</div>';
const cfLead = '<p class="dlg-p muted">Check the details below. Tap <b>Amend</b> to go back and correct anything.</p>';

/** Closed filterable dropdown: typing a letter/number opens it with that text already in the search box */
function typeToSearch(w) {
  if (!w || !w.wrapper) return w;
  // Listen on the parent in the capture phase so this runs before Kendo's own key handling
  const host = w.wrapper[0].parentNode;
  host.addEventListener('keydown', e => {
    if (e.target !== w.wrapper[0]) return;
    if (w.popup && w.popup.visible()) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopImmediatePropagation(); w.open(); return; }
    if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey && w.options.filter && w.options.filter !== 'none') {
      e.preventDefault(); e.stopImmediatePropagation();
      const key = e.key;
      w.popup.one('activate', () => setTimeout(() => {
        const f = w.filterInput; if (!f) return;
        f.val(f.val() + key); try { f[0].setSelectionRange(f.val().length, f.val().length); } catch (x) {}
        f.trigger('input');                           // Kendo filters on the filter box's input event
      }, 0));
      w.open();
    }
  }, true);
  return w;
}

/** Searchable vessel picker (Kendo DropDownList with filter) used by Prediction and Departure */
function vesselPicker(sel, list, metaFn, onPick) {
  const w = $(sel).kendoDropDownList({
    dataSource: list.map(r => ({ id: r.id, text: r.vessel_name + ' · ' + r.vessel_reference, vessel: r.vessel_name, ref: r.vessel_reference, meta: metaFn(r) })),
    dataTextField: 'text', dataValueField: 'id',
    optionLabel: 'Search or select vessel…',
    filter: 'contains', delay: 120, size: 'large', height: 340,
    template: d => `<div class="qc-opt"><b>${esc(d.vessel)} <span class="muted">· ${esc(d.ref)}</span></b><span>${esc(d.meta)}</span></div>`,
    noDataTemplate: () => '<div class="muted" style="padding:12px">No vessel matches your search</div>',
    change() { const v = this.value(); if (v) afterPopup(this, () => onPick(v)); }
  }).data('kendoDropDownList');
  if (w.filterInput) w.filterInput.attr('placeholder', 'Type vessel name or reference…');
  return typeToSearch(w);
}

function setBusy(btn, busy, label) {
  if (!btn) return;
  const $el = btn.element;
  if (busy) { $el.data('label', $el.find('.k-button-text').html()); btn.enable(false); $el.find('.k-button-text').html('<span class="spin"></span>' + (label || 'Saving…')); }
  else { btn.enable(true); if ($el.data('label')) $el.find('.k-button-text').html($el.data('label')); }
}

function timeField(id, label, hint) {
  return `<div class="fld">
    <div class="fld-top"><label class="k-label fld-label" for="${id}">${label}</label>
      <button type="button" class="dchip" id="${id}-dc" data-dchip="${id}" tabindex="-1"></button></div>
    <div class="time-row">
      <input id="${id}" />
      <button type="button" class="now-btn" data-now="${id}" tabindex="-1" title="Set to current time" aria-label="Set ${label} to current time"><i class="ti ti-clock-bolt"></i>Now</button>
    </div>
    <div class="fld-msg" id="${id}-msg">${hint || ''}</div>
  </div>`;
}

/** Accepts 0830, 830, 8:30, 08.30, 8 30 → "08:30" (null if not a valid 24-h time) */
function normalizeTime(raw) {
  const s = String(raw || '').trim();
  let h, m;
  let x = /^(\d{1,2})[:.\s](\d{2})$/.exec(s);
  if (x) { h = +x[1]; m = +x[2]; }
  else if (/^\d{3,4}$/.test(s)) { h = +s.slice(0, s.length - 2); m = +s.slice(-2); }
  else return null;
  return h <= 23 && m <= 59 ? pad(h) + ':' + pad(m) : null;
}
/** Field-to-field flow for keyboard / numeric-keypad entry */
const NEXT_FIELD = {
  'a-vessel': 'a-ref', 'a-ref': 'a-fl', 'a-fl': 'a-rtw', 'a-rtw': 'a-fli', 'a-fli': 'a-rem',
  'd-ll': 'd-po', 'd-po': 'd-srt', 'd-srt': 'd-line', 'd-line': 'd-rem',
  'p-cmph': 'p-f1', 'p-f1': 'p-f2', 'p-f2': 'p-f3', 'p-f3': 'p-f4', 'p-f4': 'p-f5', 'p-f5': 'p-f6', 'p-f6': 'p-f7', 'p-f7': 'p-f8', 'p-f8': 'p-rem'
};
function focusField(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const w = kendo.widgetInstance($(el));
  if (w && w.focus && !(w instanceof kendo.ui.TimePicker)) w.focus(); else el.focus();
  if (el.select && el.tagName === 'INPUT') { try { el.select(); } catch (e) {} }
}
const focusNext = id => { if (NEXT_FIELD[id]) focusField(NEXT_FIELD[id]); };   // synchronous: no keystrokes lost on fast typing
/** Enter in a single-line field jumps to the next field instead of doing nothing */
function enterToNext(id) {
  $('#' + id).on('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); focusNext(id); } });
}
/** After a failed "Calculate", jump to the first field that needs attention */
function focusFirstError() {
  const m = $v().find('.fld-msg.is-error').first();
  if (!m.length) return;
  const id = m.attr('id').replace(/-msg$/, '');
  const el = document.getElementById(id);
  if (!el) return;
  (el.closest('.fld') || el).scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => focusField(id), 300);
}

function initTimePicker(id, value, onChange) {
  const el = document.getElementById(id);
  el.setAttribute('inputmode', 'numeric');
  el.setAttribute('placeholder', 'HH:mm');
  el.setAttribute('autocomplete', 'off');
  el.setAttribute('enterkeyhint', 'next');
  const w = $(el).kendoTimePicker({
    format: 'HH:mm',
    parseFormats: ['HH:mm', 'HHmm', 'H:mm', 'Hmm', 'HH.mm', 'H.mm'],
    interval: 5,
    size: 'large',
    value: value ? hmToDate(value) : null,
    change: onChange
  }).data('kendoTimePicker');
  const commit = () => {
    const hm = normalizeTime(el.value);
    if (hm) { el.value = hm; w.value(hmToDate(hm)); w.trigger('change'); return true; }
    return false;
  };
  // Typing a complete time (0830 or 8:30) commits it and moves to the next field — no Tab needed
  $(el).on('input', () => {
    setMsg(id, '');                                   // clear a stale error while typing
    const raw = el.value.trim();
    el._raw = raw;                                    // remember exactly what was typed (Kendo reformats on blur)
    if ((/^\d{4}$/.test(raw) || /^\d{1,2}[:.]\d{2}$/.test(raw)) && commit()) focusNext(id);
  });
  $(el).on('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); el._raw = null; if (commit() || w.value()) focusNext(id); else onChange(); }
    else if (e.key === 'Tab') { el._raw = null; commit(); }   // our rules first (e.g. 015 → 00:15)
  });
  // On leaving the field (tap elsewhere), apply our reading of what was typed — e.g. 830 → 08:30, 015 → 00:15
  $(el).on('blur', () => setTimeout(() => {
    const typed = el._raw; el._raw = null;
    const hm = typed != null ? normalizeTime(typed) : null;
    if (hm) { if (!w.value() || toHM(w.value()) !== hm) { el.value = hm; w.value(hmToDate(hm)); w.trigger('change'); } }
    else if (!w.value() && el.value.trim()) onChange();
  }, 0));
  $(el).on('focus', () => { try { el.select(); } catch (e) {} });
  DTW[id] = w;
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
    const id = this.getAttribute('data-now'), w = map[id];
    if (!w) return;
    w.value(new Date());
    if (DT[id]) { DT[id].date = ymd(new Date()); DT[id].manual = false; }
    w.trigger('change');
  });
  $v().off('click.dchip').on('click.dchip', '[data-dchip]', function (e) { e.stopPropagation(); openDatePop(this.getAttribute('data-dchip'), this); });
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

// If an optional column (e.g. the *_at date-times) hasn't been added in Supabase yet, drop just that
// column and retry, so saving never breaks. Run migration_add_datetimes.sql to enable them.
const missingCol = e => { const m = e && /'([a-z0-9_]+)' column/i.exec(e.message || ''); return e && e.code === 'PGRST204' && m ? m[1] : null; };
const OPTIONAL_COLS = /(_at|^prediction_base_at)$/;
async function dbWrite(run, payload) {
  let body = Object.assign({}, payload);
  for (let i = 0; i < 12; i++) {
    const { error } = await run(body);
    if (!error) return null;
    const col = missingCol(error);
    if (col && col !== 'created_at' && OPTIONAL_COLS.test(col) && col in body) {
      console.warn(`Column ${col} not in database — saved without it. Run migration_add_datetimes.sql.`);
      delete body[col]; continue;
    }
    return error;
  }
  return { message: 'Too many missing columns' };
}
async function dbInsert(rec) {
  const err = await dbWrite(b => window.sb.from('vsr_records').insert([b]), rec);
  if (err) { toast('Save failed: ' + (err.message || err), 'error'); return false; }
  return true;
}
async function dbUpdate(id, updates) {
  const err = await dbWrite(b => window.sb.from('vsr_records').update(b).eq('id', id), updates);
  if (err) { toast('Update failed: ' + (err.message || err), 'error'); return false; }
  return true;
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
  store.set('ptp_predSel', S.predSel || ''); store.set('ptp_depSel', S.depSel || '');
  $('.tab').each(function () { this.setAttribute('aria-selected', this.getAttribute('data-view') === view); });
  renderView();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (view !== 'arrival') loadRecords(true).then(() => { if (S.view === view) refreshCurrentLists(); });
}

function teardownView() {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  closeDatePop();
  DTW = {};
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
  v.on('input change', 'input, textarea', () => saveDrafts());
  v.on('click', '.dpop button, [data-now]', () => saveDrafts());
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
  pruneDrafts();
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
    const restored = loadDrafts();
    renderRoot();
    if (restored) toast('Unsaved entries restored from this device', 'info');
    loadRecords().then(() => refreshCurrentLists());
  });
}
function logout() {
  saveDrafts(true);                                   // keep this operator's drafts for when they sign back in
  S.operator = ''; store.del('ptp_op');
  S.arrDraft = emptyArr(); S.predDrafts = {}; S.predDraft = emptyPred(); S.depDraft = {}; S.predSel = null; S.depSel = null;
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
        <div class="rule"><i class="ti ti-shield-check"></i><span>Poka-yoke: First Line ≤ RTW. First Lift <b>before</b> RTW is allowed — it is saved as a <b>negative Quick Start</b> (please explain in remarks). Dates fill in automatically, including past midnight; tap a date to change it.</span></div>
      </section>

      <section class="card">
        <h2 class="card-t"><i class="ti ti-message-2"></i>Remarks <span class="req">*</span></h2>
        <textarea id="a-rem"></textarea>
        <div class="fld-msg" id="a-rem-msg"></div>
      </section>
    </div>

    <aside class="col-side">
      <section class="card result sticky" id="arr-result"></section>
      <button id="a-save" class="save-btn"><i class="ti ti-calculator"></i>&nbsp;Calculate arrival</button>
      ${draftNote()}
      <button id="a-clear" class="link-btn" type="button"><i class="ti ti-eraser"></i> Clear form</button>
    </aside>
  </div>`);

  W.vessel = $('#a-vessel').kendoTextBox({ placeholder: 'e.g. EVER GIVEN', size: 'large', value: d.vessel }).data('kendoTextBox');
  $('#a-vessel').css('text-transform', 'uppercase').on('input', function () { S.arrDraft.vessel = upperInput(this); setMsg('a-vessel', ''); });
  W.ref = $('#a-ref').kendoTextBox({ placeholder: 'e.g. VOY-2026-001', size: 'large', value: d.reference }).data('kendoTextBox');
  $('#a-ref').css('text-transform', 'uppercase').on('input', function () { S.arrDraft.reference = upperInput(this); setMsg('a-ref', ''); });
  $('#a-vessel, #a-ref').attr({ autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'next' });
  enterToNext('a-vessel'); enterToNext('a-ref');

  const onT = () => evalArrival();
  W.fl = initTimePicker('a-fl', d.fl, onT);
  W.rtw = initTimePicker('a-rtw', d.rtw, onT);
  W.fli = initTimePicker('a-fli', d.fli, onT);
  bindNowButtons({ 'a-fl': W.fl, 'a-rtw': W.rtw, 'a-fli': W.fli });
  initDTGroup('arr', d.dates);

  W.rem = $('#a-rem').kendoTextArea({ rows: 3, maxLength: 500, placeholder: 'Anything that affected the arrival — berth readiness, lashing gang, crane availability…', size: 'large', value: d.remarks, resize: 'vertical' }).data('kendoTextArea');
  $('#a-rem').on('input', function () { S.arrDraft.remarks = this.value; setMsg('a-rem', ''); });

  W.save = kButton('#a-save', { themeColor: 'primary' });
  W.save.bind('click', confirmArrival);
  $('#a-clear').on('click', () => { S.arrDraft = emptyArr(); saveDrafts(true); renderView(); });

  evalArrival();
}

function evalArrival() {
  const fl = readTime(W.fl), rtw = readTime(W.rtw), fli = readTime(W.fli);
  Object.assign(S.arrDraft, { fl: fl.hm, rtw: rtw.hm, fli: fli.hm });
  dtSync('arr');
  let ok = true;
  [['a-fl', fl], ['a-rtw', rtw], ['a-fli', fli]].forEach(([id, t]) => {
    if (t.bad) { setMsg(id, 'Enter time as HH:mm (e.g. 08:30)', 'error'); ok = false; }
    else setMsg(id, '');
  });
  const A = readDT('a-fl'), B = readDT('a-rtw'), C = readDT('a-fli');
  let seqErr = null;
  // Poka-yoke: RTW can't be before First Line (date-aware)
  if (A && B && B.dt < A.dt) {
    seqErr = `RTW (${fmtDT(B.dt)}) is earlier than First Line (${fmtDT(A.dt)}).`;
    setMsg('a-rtw', '<i class="ti ti-alert-triangle"></i> Earlier than First Line', 'error'); ok = false;
  }
  // First Lift before RTW is allowed (negative Quick Start) — flagged, not blocked
  if (ok && B && C && C.dt < B.dt) setMsg('a-fli', '<i class="ti ti-info-circle"></i> Before RTW — allowed, explain in remarks', 'warn');

  const box = $('#arr-result');
  if (!(A && B && C)) {
    box.html(resultPlaceholder('Quick Start', 'Enter all three arrival times, then tap Calculate arrival.', TARGET.qs));
    return null;
  }
  if (!ok) {
    box.html(`<div class="res-head">Quick Start</div>
      <div class="res-error"><i class="ti ti-alert-octagon"></i><div><b>Sequence error</b><br>${esc(seqErr || 'Check the times entered.')}</div></div>`);
    return null;
  }
  const qs = diffMin(B.dt, C.dt);
  const cls = classify(qs, TARGET.qs);
  const tl = d => d.date === A.date ? d.hm : `${d.hm} <small>${fmtDay(d.date)}</small>`;
  box.html(readyBox('Quick Start', 'Calculate arrival', TARGET.qs));
  const html = (`
    <div class="res-head">Quick Start <span class="res-sub">First Lift − RTW</span></div>
    ${bigMetric(qs, 'min', cls, TARGET.qs)}
    ${gauge(qs, TARGET.qs)}
    ${qs < 0 ? `<div class="res-neg"><i class="ti ti-arrow-back-up"></i><div><b>Negative Quick Start</b> — first lift ${-qs} min before the vessel was secured. It will be saved as ${qs} min; explain why in remarks.</div></div>` : ''}
    <div class="timeline">
      ${A.date !== ymd(new Date()) || C.date !== A.date ? `<div class="tl-date">${fmtDay(A.date)}</div>` : ''}
      ${tlStep('First line', tl(A))}
      ${tlGap(diffMin(A.dt, B.dt))}
      ${tlStep('RTW', tl(B))}
      ${tlGap(qs, cls)}
      ${tlStep('First lift', tl(C))}
    </div>`);
  return { fl: A.hm, rtw: B.hm, fli: C.hm, flAt: A.dt, rtwAt: B.dt, fliAt: C.dt, qs, cls, html };
}

/** Side panel once inputs are complete — results stay hidden until Calculate → confirm → save */
function readyBox(title, btnLabel, target) {
  return `<div class="res-head">${title}</div>
    <div class="res-ready"><i class="ti ti-circle-check"></i><div><b>Ready to calculate</b><br>Tap <b>${btnLabel}</b>, check the details in the popup, then <b>Calculate &amp; save</b> to see the result.</div></div>
    ${target != null ? `<div class="res-target">Target ≤ ${target} min</div>` : ''}`;
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
    <div class="res-target">Target ≤ ${target} ${unit} · ${val < 0 ? `negative (${-val} ${unit} early)` : cls === 'GOOD' ? `${target - val} ${unit} under target` : `${val - target} ${unit} over target`}</div>`;
}
function gauge(val, target) {
  const max = Math.max(target * 2, val);
  const pct = Math.max(0, Math.min(100, val / max * 100));   // negative values sit at the start
  const tpct = target / max * 100;
  return `<div class="gauge" role="img" aria-label="${val} of ${target} target">
    <div class="gauge-fill ${val <= target ? 'good' : 'bad'}" style="width:${pct}%"></div>
    <div class="gauge-tgt" style="left:${tpct}%"><span>${target}</span></div>
  </div>`;
}
const tlStep = (label, t) => `<div class="tl-step"><span class="tl-dot"></span><span class="tl-l">${label}</span><span class="tl-t">${t}</span></div>`;
const tlGap = (m, cls) => `<div class="tl-gap ${cls ? (cls === 'GOOD' ? 'good' : 'bad') : ''}">${m} min</div>`;

/** Validate, then show the confirmation popup (Amend / Calculate & save) */
function confirmArrival() {
  const vessel = String(W.vessel.value() || '').trim().toUpperCase();
  const ref = String(W.ref.value() || '').trim().toUpperCase();
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
  if (errs.length) { toast('Please complete: ' + errs.join(', '), 'warning'); focusFirstError(); return; }

  const dup = S.records.find(x => phaseOf(x) !== 'completed' && x.vessel_name === vessel && String(x.vessel_reference || '').toUpperCase() === ref);
  openDialog({
    title: 'Confirm arrival details',
    width: 460,
    html: `<div class="dlg-sum">
      ${cfLead}
      <div class="dlg-vessel"><i class="ti ti-ship"></i>${esc(vessel)} <span>· ${esc(ref)}</span></div>
      ${dup ? `<div class="cf-warn"><i class="ti ti-alert-triangle"></i><div><b>Possible duplicate</b> — this vessel already has an open record (${esc(PHASES[phaseOf(dup)].label.toLowerCase())}, created ${esc(relTime(dup.created_at))}).</div></div>` : ''}
      ${cfSec('Arrival times')}
      ${cfKV('First line', esc(fmtDT(r.flAt)))}
      ${cfKV('Vessel secured (RTW)', esc(fmtDT(r.rtwAt)))}
      ${cfKV('First lift', esc(fmtDT(r.fliAt)))}
      ${r.qs < 0 ? `<div class="cf-warn"><i class="ti ti-arrow-back-up"></i><div>First Lift is <b>before</b> RTW — this is allowed. Make sure the remarks explain why.</div></div>` : ''}
      ${cfSec('Remarks')}
      ${cfRem(rem)}
    </div>`,
    actions: [
      { text: 'Amend' },
      { text: 'Calculate & save', primary: true, action: () => { saveArrival({ vessel, ref, rem, r }); return true; } }
    ]
  });
}

async function saveArrival({ vessel, ref, rem, r }) {
  const rec = {
    id: genId(),
    vessel_name: vessel,
    vessel_reference: ref,
    first_line_time: r.fl,
    rtw_time: r.rtw,
    first_lift_time: r.fli,
    first_line_at: r.flAt.toISOString(),
    rtw_at: r.rtwAt.toISOString(),
    first_lift_at: r.fliAt.toISOString(),
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
  S.arrDraft = emptyArr();
  saveDrafts(true);
  toast(`Arrival saved · ${rec.vessel_name}`, 'success');
  openDialog({
    title: 'Arrival saved',
    html: `<div class="dlg-sum">
      <div class="dlg-vessel"><i class="ti ti-ship"></i>${esc(rec.vessel_name)} <span>· ${esc(rec.vessel_reference)}</span></div>
      <div class="result-in-dlg">${r.html}</div>
      <p class="dlg-p muted">Next: record the departure prediction once the final crane plan is known.</p>
    </div>`,
    width: 440,
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
      <div class="fld pick-fld">
        <label class="k-label fld-label" for="p-pick">Search vessel</label>
        <input id="p-pick" />
        <div class="fld-msg">Type part of the vessel name or reference, or tap a vessel below.</div>
      </div>
      ${queueHTML(pending, null, 'pred')}
    </section>`);
    const pick = id => { S.predSel = id; saveDrafts(true); renderView(); };
    W.pick = vesselPicker('#p-pick', pending, r => `QS ${r.quick_start_minutes} min · arrived ${relTime(r.created_at)}`, pick);
    v.on('click', '.q-item', function () { pick(this.getAttribute('data-id')); });
    return;
  }

  const r = S.records.find(x => x.id === S.predSel);
  S.predDraft = S.predDrafts[S.predSel] || (S.predDrafts[S.predSel] = emptyPred());
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
      <button id="p-save" class="save-btn"><i class="ti ti-calculator"></i>&nbsp;Calculate prediction</button>
      ${draftNote()}
    </aside>
  </div>`);

  v.on('click', '[data-change]', () => { S.predSel = null; renderView(); });

  W.qc = $('#p-qc').kendoDropDownList({
    dataSource: QC_DB,
    dataTextField: 'qc',
    dataValueField: 'qc',
    optionLabel: 'Select crane…',
    filter: 'contains', delay: 120,
    size: 'large',
    value: d.qc,
    template: q => `<div class="qc-opt"><b>${esc(q.qc)}</b><span>${esc(q.model || '')} · ${esc(q.speed)} m/min</span></div>`,
    valueTemplate: q => q && q.qc ? `<span class="qc-val"><b>${esc(q.qc)}</b> <span>${esc(q.model || '')} · ${esc(q.speed)} m/min</span></span>` : '<span class="k-input-value-text">Select crane…</span>',
    change() { S.predDraft.qc = this.value(); setMsg('p-qc', ''); evalPrediction(); if (this.value()) afterPopup(this, () => focusField('p-cmph')); }
  }).data('kendoDropDownList');
  typeToSearch(W.qc);

  $('#p-cmph').attr('inputmode', 'decimal');
  W.cmph = $('#p-cmph').kendoNumericTextBox({
    min: 1, max: 80, step: 1, decimals: 1, format: '#.#', size: 'large', placeholder: 'e.g. 28', value: d.cmph, selectOnFocus: true,
    suffixOptions: { template: () => 'moves/hr' },
    change() { evalPrediction(); }, spin() { evalPrediction(); }
  }).data('kendoNumericTextBox');
  W.cmph.wrapper.find('input').attr('inputmode', 'decimal');
  $('#p-cmph').on('input', () => evalPrediction());
  enterToNext('p-cmph');

  WORKLOAD.forEach(f => {
    $('#p-' + f.id).attr('inputmode', 'numeric');
    W[f.id] = $('#p-' + f.id).kendoNumericTextBox({
      min: 0, step: 1, decimals: 0, format: 'n0', size: 'large', placeholder: '0', value: d[f.id] || null, selectOnFocus: true,
      suffixOptions: { template: () => f.unit },
      change: () => evalPrediction(), spin: () => evalPrediction()
    }).data('kendoNumericTextBox');
    W[f.id].wrapper.find('input').attr('inputmode', 'numeric');
    $('#p-' + f.id).on('input', () => evalPrediction());
    enterToNext('p-' + f.id);
  });

  W.rem = $('#p-rem').kendoTextArea({ rows: 2, maxLength: 500, placeholder: 'Assumptions — e.g. lashing delay expected, re-stow on bay 32…', size: 'large', value: d.remarks, resize: 'vertical' }).data('kendoTextArea');
  $('#p-rem').on('input', function () { S.predDraft.remarks = this.value; });

  W.save = kButton('#p-save', { themeColor: 'primary' });
  W.save.bind('click', confirmPrediction);

  evalPrediction();

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
  saveDrafts();
  const qc = QC_DB.find(q => q.qc === d.qc);
  const speed = qc ? qc.speed : DEFAULT_QC_SPEED;
  const cmph = d.cmph || 0;
  const base = cmph > 0 ? 60 / cmph : 0;

  setMsg('p-cmph', ''); WORKLOAD.forEach(f => setMsg('p-' + f.id, ''));

  const box = $('#pred-result');
  const totalMoves = WORKLOAD.filter(f => f.factor).reduce((s, f) => s + d[f.id], 0);
  if (!d.qc || !(cmph > 0) || (!totalMoves && !d.f7 && !d.f8)) {
    const need = [!d.qc && 'crane', !(cmph > 0) && 'CMPH', (!totalMoves && !d.f7 && !d.f8) && 'workload'].filter(Boolean).join(', ');
    box.html(resultPlaceholder('Departure prediction', `Enter ${need}, then tap Calculate prediction.`));
    return null;
  }
  const res = calcPrediction(d, cmph, speed);
  const now = new Date();
  const ll = addMin(now, res.totalMin);
  const srt = roundUpTo15(ll);
  const nextDay = ll.getDate() !== now.getDate();
  const parts = [['Container work', res.containerMin, 'c1'], ['Gantry travel', res.gantryMin, 'c2'], ['Breakdown', res.bufferMin, 'c3']];
  box.html(readyBox('Departure prediction', 'Calculate prediction'));
  const html = (`
    <div class="res-head">Departure prediction <span class="res-sub">calculated at ${toHM(now)}</span></div>
    <div class="pred-times">
      <div class="pt"><span>Predicted last lift</span><b class="t-blue">${toHM(ll)}</b>${nextDay ? `<em>${fmtDay(ymd(ll))}</em>` : ''}</div>
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
  return { res, ll, srt, qc, speed, now, html };
}

/** Validate, then show the confirmation popup (Amend / Calculate & save) */
function confirmPrediction() {
  const d = S.predDraft;
  const errs = [];
  if (!d.qc) { setMsg('p-qc', 'Select the last crane', 'error'); errs.push('crane'); }
  if (!(readNum(W.cmph) > 0)) { setMsg('p-cmph', 'CMPH is required', 'error'); errs.push('CMPH'); }
  if (errs.length) { toast('Please complete: ' + errs.join(', '), 'warning'); focusFirstError(); return; }
  const p = evalPrediction();
  if (!p) { toast('Enter the remaining workload before saving.', 'warning'); focusField('p-f1'); return; }
  const r = S.records.find(x => x.id === S.predSel);
  const rem = String(W.rem.value() || '').trim();
  const wl = WORKLOAD.filter(f => +d[f.id] > 0).map(f => cfKV(f.label, `${d[f.id]} ${f.unit.toLowerCase()}`)).join('');
  openDialog({
    title: 'Confirm prediction details',
    width: 480,
    html: `<div class="dlg-sum">
      ${cfLead}
      <div class="dlg-vessel"><i class="ti ti-ship"></i>${esc(r.vessel_name)} <span>· ${esc(r.vessel_reference)}</span></div>
      ${cfSec('Crane setup')}
      ${cfKV('Last crane (QC)', esc(d.qc), `<span class="muted sm">${esc(p.qc ? p.qc.model : 'default')} · ${esc(p.speed)} m/min</span>`)}
      ${cfKV('CMPH', esc(d.cmph))}
      ${cfSec('Remaining workload')}
      ${wl}
      ${cfSec('Remarks')}
      ${cfRem(rem)}
      <div class="cf-note"><i class="ti ti-clock"></i><div>Predicted last lift and SRT are calculated from the moment you tap <b>Calculate &amp; save</b>.</div></div>
    </div>`,
    actions: [
      { text: 'Amend' },
      { text: 'Calculate & save', primary: true, action: () => { savePrediction(); return true; } }
    ]
  });
}

async function savePrediction() {
  const d = S.predDraft;
  const p = evalPrediction();          // recomputed against the clock right now
  if (!p) { toast('Enter the remaining workload before saving.', 'warning'); return; }
  const rem = String(W.rem.value() || '').trim();
  const id = S.predSel;
  const upd = {
    qc_number: d.qc, qc_model: p.qc ? p.qc.model : '', qc_speed: p.speed, cmph: +d.cmph,
    f1: +d.f1, f2: +d.f2, f3: +d.f3, f4: +d.f4, f5: +d.f5, f6: +d.f6, f7: +d.f7, f8: +d.f8,
    container_min: p.res.containerMin, gantry_min: p.res.gantryMin, buffer_min: p.res.bufferMin, total_min: p.res.totalMin,
    predicted_last_lift_time: toHM(p.ll), suggested_srt: toHM(p.srt),
    predicted_last_lift_at: p.ll.toISOString(), suggested_srt_at: p.srt.toISOString(), prediction_base_at: p.now.toISOString(),
    prediction_remarks: rem, prediction_operator: S.operator
  };
  setBusy(W.save, true);
  const ok = await dbUpdate(id, upd);
  setBusy(W.save, false);
  if (!ok) return;

  const rec = S.records.find(x => x.id === id);
  Object.assign(rec, upd);
  updateNavCounts();
  delete S.predDrafts[id];
  S.predSel = null;
  S.predDraft = emptyPred();
  saveDrafts(true);
  toast(`Prediction saved · ${rec.vessel_name}`, 'success');
  openDialog({
    title: 'Prediction saved',
    html: `<div class="dlg-sum">
      <div class="dlg-vessel"><i class="ti ti-ship"></i>${esc(rec.vessel_name)} <span>· ${esc(rec.vessel_reference)}</span></div>
      <div class="dlg-call"><span>Call pilot for SRT${ymd(p.srt) !== ymd(new Date()) ? ` <em>${fmtDay(ymd(p.srt))}</em>` : ''}</span><b>${esc(upd.suggested_srt)}</b></div>
      <div class="result-in-dlg">${p.html}</div>
    </div>`,
    width: 460,
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
      <div class="fld pick-fld">
        <label class="k-label fld-label" for="d-pick">Search vessel</label>
        <input id="d-pick" />
        <div class="fld-msg">Type part of the vessel name or reference, or tap a vessel below.</div>
      </div>
      ${queueHTML(ready, null, 'dep')}
    </section>`);
    const pick = id => { S.depSel = id; saveDrafts(true); renderView(); };
    W.pick = vesselPicker('#d-pick', ready, r => `SRT ${showAt(r, 'suggested_srt_at', 'suggested_srt')} · QC ${r.qc_number || '—'} · pred. LL ${showAt(r, 'predicted_last_lift_at', 'predicted_last_lift_time')}`, pick);
    v.on('click', '.q-item', function () { pick(this.getAttribute('data-id')); });
    return;
  }

  const r = S.records.find(x => x.id === S.depSel);
  const srtAt0 = recAt(r, 'suggested_srt_at', 'suggested_srt');
  const winStart = toHM(addMin(srtAt0, -TARGET.srtWindow));
  v.html(`
  ${stepper('departure')}
  ${selectedStrip(r, `
    <div><span>Pred. last lift</span><b class="t-blue">${esc(showAt(r, 'predicted_last_lift_at', 'predicted_last_lift_time'))}</b></div>
    <div><span>Rec. SRT</span><b class="t-green">${esc(showAt(r, 'suggested_srt_at', 'suggested_srt'))}</b></div>
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
        <div class="rule"><i class="ti ti-shield-check"></i>Poka-yoke: Last Line cannot be earlier than Actual Last Lift. Dates fill in automatically, including past midnight; tap a date to change it.</div>
      </section>
      <section class="card">
        <h2 class="card-t"><i class="ti ti-message-2"></i>Remarks <span class="req">*</span></h2>
        <textarea id="d-rem"></textarea>
        <div class="fld-msg" id="d-rem-msg"></div>
      </section>
    </div>
    <aside class="col-side">
      <section class="card result sticky" id="dep-result"></section>
      <button id="d-save" class="save-btn"><i class="ti ti-calculator"></i>&nbsp;Calculate departure</button>
      ${draftNote()}
    </aside>
  </div>`);

  v.on('click', '[data-change]', () => { S.depSel = null; renderView(); });
  const onT = () => evalDeparture(r);
  const dd = S.depDraft[r.id] || (S.depDraft[r.id] = {});
  W.ll = initTimePicker('d-ll', dd.ll, onT);
  W.po = initTimePicker('d-po', dd.po, onT);
  W.srt = initTimePicker('d-srt', dd.srt, onT);
  W.line = initTimePicker('d-line', dd.line, onT);
  bindNowButtons({ 'd-ll': W.ll, 'd-po': W.po, 'd-srt': W.srt, 'd-line': W.line });
  initDTGroup('dep', dd.dates);
  W.depRec = r;
  W.rem = $('#d-rem').kendoTextArea({ rows: 3, maxLength: 500, placeholder: 'What happened — delays, breakdowns, early completion, pilot late…', size: 'large', resize: 'vertical', value: dd.rem || '' }).data('kendoTextArea');
  $('#d-rem').on('input', function () { dd.rem = this.value; setMsg('d-rem', ''); });
  W.save = kButton('#d-save', { themeColor: 'primary' });
  W.save.bind('click', () => confirmDeparture(r));
  evalDeparture(r);
}

function evalDeparture(r) {
  dtSync('dep');
  const t = { ll: readTime(W.ll), po: readTime(W.po), srt: readTime(W.srt), line: readTime(W.line) };
  let ok = true;
  Object.entries({ 'd-ll': t.ll, 'd-po': t.po, 'd-srt': t.srt, 'd-line': t.line }).forEach(([id, x]) => {
    if (x.bad) { setMsg(id, 'Enter time as HH:mm', 'error'); ok = false; } else setMsg(id, '');
  });
  const LL = readDT('d-ll'), PO = readDT('d-po'), SR = readDT('d-srt'), LN = readDT('d-line');
  // Prediction times as full date-times (legacy rows without *_at are placed nearest the actual last lift)
  const anchor = LL ? LL.dt : new Date();
  const srtAt = recAt(r, 'suggested_srt_at', 'suggested_srt', anchor);
  const predAt = recAt(r, 'predicted_last_lift_at', 'predicted_last_lift_time', anchor);
  const winStartAt = addMin(srtAt, -TARGET.srtWindow);
  const winStart = toHM(winStartAt);
  if (LL && LN && LN.dt < LL.dt) {
    setMsg('d-line', '<i class="ti ti-alert-triangle"></i> Earlier than Actual Last Lift', 'error'); ok = false;
  }

  const box = $('#dep-result');
  const srtCls = LL ? ((LL.dt >= winStartAt && LL.dt <= srtAt) ? 'GOOD' : 'NOT QUALITY') : null;
  const qsStart = +r.quick_start_minutes || 0;
  if (!ok && LN && LL && LN.dt < LL.dt) {
    box.html(`<div class="res-head">Departure result</div><div class="res-error"><i class="ti ti-alert-octagon"></i><div><b>Sequence error</b><br>Last Line (${esc(fmtDT(LN.dt))}) is earlier than Last Lift (${esc(fmtDT(LL.dt))}).</div></div>`);
  } else if (!(LL && PO && SR && LN)) {
    box.html(resultPlaceholder('Departure result', 'Enter all four departure times, then tap Calculate departure.'));
  } else if (ok) {
    box.html(readyBox('Departure result', 'Calculate departure'));
  }
  let html = '';
  if (LL && LN && ok) {
    const qsail = diffMin(LL.dt, LN.dt);
    const qsailCls = classify(qsail, TARGET.qsail);
    const idle = qsStart + qsail;
    const idleCls = classify(idle, TARGET.idle);
    const dev = diffMin(predAt, LL.dt);
    html = `<div class="res-block">
      <div class="res-row"><span>SRT compliance</span>${badge(srtCls)}</div>
      ${srtWindowViz(r.suggested_srt, LL.hm, diffMin(srtAt, LL.dt))}
      <div class="res-note">GOOD window ${winStart} – ${esc(fmtAt(srtAt))} · last lift ${dev > 0 ? '+' : ''}${dev} min vs predicted ${esc(fmtAt(predAt))}</div>
    </div>
    <div class="res-block">
      <div class="res-row"><span>Quick Sail <em>Last Line − Last Lift</em></span><b>${qsail} min</b>${badge(qsailCls)}</div>
      ${gauge(qsail, TARGET.qsail)}
    </div>
    <div class="res-block">
      <div class="res-row"><span>Total Idle <em>QS ${esc(qsStart)} + QSail ${qsail}</em></span><b>${idle} min</b>${badge(idleCls)}</div>
      ${gauge(idle, TARGET.idle)}
      ${qsStart < 0 ? `<div class="res-note">Includes a negative Quick Start (${qsStart} min) from arrival.</div>` : ''}
    </div>`;
  }

  if (!ok || !(LL && PO && SR && LN)) return null;
  const qsail = diffMin(LL.dt, LN.dt);
  const idle = qsStart + qsail;
  return {
    ll: LL.hm, po: PO.hm, srt: SR.hm, line: LN.hm, winStart,
    llAt: LL.dt, poAt: PO.dt, srtAtActual: SR.dt, lineAt: LN.dt, srtAt, predAt,
    srtCls, dev: diffMin(predAt, LL.dt),
    qsail, qsailCls: classify(qsail, TARGET.qsail), idle, idleCls: classify(idle, TARGET.idle), html
  };
}

function srtWindowViz(srt, ll, offMin) {
  // 60-minute axis: SRT-45 … SRT+15; window is SRT-15 … SRT
  const span = 60, startOff = -45;
  const pos = m => ((m - startOff) / span) * 100;
  let marker = '';
  if (ll) {
    const off = offMin != null ? offMin : -circDiff(ll, srt);   // ll relative to srt (negative = before)
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

/** Validate, then show the confirmation popup (Amend / Calculate & save) */
function confirmDeparture(r) {
  const res = evalDeparture(r);
  const rem = String(W.rem.value() || '').trim();
  const errs = [];
  if (!res) {
    [['d-ll', W.ll], ['d-po', W.po], ['d-srt', W.srt], ['d-line', W.line]].forEach(([id, w]) => { if (!readTime(w).hm && !readTime(w).bad) setMsg(id, 'Required', 'error'); });
    errs.push('all four valid times');
  }
  if (!rem) { setMsg('d-rem', 'Remarks are mandatory', 'error'); errs.push('remarks'); }
  if (errs.length) { toast('Please complete: ' + errs.join(', '), 'warning'); focusFirstError(); return; }
  openDialog({
    title: 'Confirm departure details',
    width: 480,
    html: `<div class="dlg-sum">
      ${cfLead}
      <div class="dlg-vessel"><i class="ti ti-ship"></i>${esc(r.vessel_name)} <span>· ${esc(r.vessel_reference)}</span></div>
      ${cfSec('Prediction')}
      ${cfKV('Predicted last lift', esc(fmtDT(res.predAt)))}
      ${cfKV('Recommended SRT', esc(fmtDT(res.srtAt)))}
      ${cfSec('Actual departure times')}
      ${cfKV('Actual last lift', esc(fmtDT(res.llAt)))}
      ${cfKV('Pilot onboard', esc(fmtDT(res.poAt)))}
      ${cfKV('Actual SRT', esc(fmtDT(res.srtAtActual)))}
      ${cfKV('Last line', esc(fmtDT(res.lineAt)))}
      ${cfSec('Remarks')}
      ${cfRem(rem)}
    </div>`,
    actions: [
      { text: 'Amend' },
      { text: 'Calculate & save', primary: true, action: () => { saveDeparture(r); return true; } }
    ]
  });
}

async function saveDeparture(r) {
  const res = evalDeparture(r);
  const rem = String(W.rem.value() || '').trim();
  if (!res || !rem) { toast('Please complete all times and remarks.', 'warning'); return; }

  const upd = {
    actual_last_lift_time: res.ll, actual_pilot_onboard_time: res.po, actual_srt_time: res.srt,
    last_line_time: res.line, srt_window_start: res.winStart, srt_window_end: r.suggested_srt,
    actual_last_lift_at: res.llAt.toISOString(), pilot_onboard_at: res.poAt.toISOString(),
    actual_srt_at: res.srtAtActual.toISOString(), last_line_at: res.lineAt.toISOString(),
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
  delete S.depDraft[r.id];
  saveDrafts(true);
  toast(`Departure saved · ${r.vessel_name}`, 'success');
  openDialog({
    title: 'Vessel call completed',
    html: `<div class="dlg-sum">
      <div class="dlg-vessel"><i class="ti ti-ship"></i>${esc(r.vessel_name)} <span>· ${esc(r.vessel_reference)}</span></div>
      <div class="dlg-kv"><span>Quick Start <em class="muted">from arrival</em></span><b>${r.quick_start_minutes} min</b>${badge(r.quick_start_class)}</div>
      <div class="result-in-dlg">${res.html}</div>
    </div>`,
    width: 460,
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
    <div class="rec-side">${r.prediction_edited ? `<span class="pill pill-edit" title="Prediction edited ${esc(r.prediction_edit_count || 1)}×"><i class="ti ti-pencil"></i>Edited</span>` : ''}${phasePill(r)}${ph === 'completed' ? `<span class="rec-srt">${badge(r.srt_class, 'SRT ' + (r.srt_class === 'GOOD' ? 'GOOD' : 'NQ'))}</span>` : ''}<i class="ti ti-chevron-right rec-chev"></i></div>
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
      ${row('First line', showAt(r, 'first_line_at', 'first_line_time'))}${row('Vessel secured (RTW)', showAt(r, 'rtw_at', 'rtw_time'))}${row('First lift', showAt(r, 'first_lift_at', 'first_lift_time'))}
      ${row('Quick Start', r.quick_start_minutes + ' min', badge(r.quick_start_class) + (+r.quick_start_minutes < 0 ? '<span class="pill pill-edit" title="First Lift before RTW">negative</span>' : ''))}
      ${remark(r.arrival_remarks)}
    </div>`;
  if (r.predicted_last_lift_time) {
    html += `<div class="d-sec"><div class="d-sec-t"><span class="dot">2</span>Departure prediction ${r.prediction_edited ? `<span class="pill pill-edit"><i class="ti ti-pencil"></i>Edited ×${esc(r.prediction_edit_count || 1)}</span>` : ''}<em>by ${esc(r.prediction_operator || '—')}</em></div>
      ${row('QC · model', `${r.qc_number} · ${r.qc_model || '—'}`)}${row('CMPH', r.cmph)}
      ${row('Total operation time', (+r.total_min).toFixed(1) + ' min')}
      ${row('Predicted last lift', showAt(r, 'predicted_last_lift_at', 'predicted_last_lift_time'))}${row('Recommended SRT', showAt(r, 'suggested_srt_at', 'suggested_srt'))}
      ${remark(r.prediction_remarks)}
      ${r.prediction_edited ? `<div class="audit-note"><i class="ti ti-history"></i><div>Edited <b>${esc(r.prediction_edit_count || 1)}×</b> · last by <b>${esc(r.prediction_last_edited_by || '—')}</b>${r.prediction_last_edited_at ? ' · ' + esc(fmtDateTime(r.prediction_last_edited_at)) : ''}${r.prediction_edit_reason ? `<br>Reason: ${esc(r.prediction_edit_reason)}` : ''}</div></div>` : ''}
    </div>`;
  }
  if (r.actual_last_lift_time) {
    html += `<div class="d-sec"><div class="d-sec-t"><span class="dot">3</span>Actual departure <em>by ${esc(r.departure_operator || '—')}</em></div>
      ${row('Actual last lift', showAt(r, 'actual_last_lift_at', 'actual_last_lift_time'))}${row('Pilot onboard', showAt(r, 'pilot_onboard_at', 'actual_pilot_onboard_time'))}
      ${row('Actual SRT', showAt(r, 'actual_srt_at', 'actual_srt_time'))}${row('Last line', showAt(r, 'last_line_at', 'last_line_time'))}
      ${row('SRT window', `${r.srt_window_start} – ${r.srt_window_end}`, badge(r.srt_class))}
      ${row('LL deviation (actual − predicted)', `${r.deviation_minutes > 0 ? '+' : ''}${r.deviation_minutes} min`)}
      ${row('Quick Sail', r.quick_sail_minutes + ' min', badge(r.quick_sail_class))}
      ${row('Total Idle', r.total_idle_minutes + ' min', badge(r.total_idle_class))}
      ${remark(r.departure_remarks)}
    </div>`;
  }
  html += '</div>';
  const actions = [{ text: 'Close' }];
  if (r.prediction_edited) actions.push({ text: 'Audit trail', action: () => { openAuditTrail(r); return true; } });
  if (r.predicted_last_lift_time) actions.push({ text: 'Edit prediction', action: () => { openEditPrediction(r); return true; } });
  if (ph === 'arrival') actions.push({ text: 'Continue to prediction', primary: true, action: () => { go('prediction', { predSel: r.id }); return true; } });
  if (ph === 'prediction') actions.push({ text: 'Continue to departure', primary: true, action: () => { go('departure', { depSel: r.id }); return true; } });
  openDialog({ title: 'Vessel call', html, actions, width: 560 });
}

// ── EDIT SAVED PREDICTION (audit-controlled) ──────────────
// The database trigger (migration_prediction_audit.sql) does the audit work: it refuses an
// edit without a fresh reason + editor ID, marks the record as edited, bumps the edit count
// and writes old → new values to vsr_audit_log in the same transaction.
const AUDIT_LABELS = {
  qc_number: 'QC number', qc_model: 'QC model', qc_speed: 'QC speed (m/min)', cmph: 'CMPH',
  f1: 'Normal container', f2: 'Twin lift', f3: 'Gearbox', f4: 'Hatch cover', f5: 'OOG', f6: 'Open top',
  f7: 'Gantry movement (bay)', f8: 'Breakdown (min)',
  container_min: 'Container work (min)', gantry_min: 'Gantry travel (min)', buffer_min: 'Breakdown buffer (min)', total_min: 'Total operation time (min)',
  predicted_last_lift_time: 'Predicted last lift', suggested_srt: 'Recommended SRT',
  predicted_last_lift_at: 'Predicted last lift (date-time)', suggested_srt_at: 'Recommended SRT (date-time)',
  prediction_remarks: 'Prediction remarks',
  srt_window_start: 'SRT window start', srt_window_end: 'SRT window end', srt_class: 'SRT result', deviation_minutes: 'LL deviation (min)'
};
const DIFF_SHOW = ['qc_number', 'cmph', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'total_min', 'predicted_last_lift_time', 'suggested_srt', 'prediction_remarks', 'srt_class', 'deviation_minutes'];

function auditVal(k, v) {
  if (v === null || v === undefined || v === '') return '—';
  if (/_at$/.test(k)) return fmtDateTime(v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(1);
  return String(v);
}
function sameVal(a, b) {
  const empty = x => x === null || x === undefined || x === '';
  if (empty(a) && empty(b)) return true;
  if (empty(a) || empty(b)) return false;
  if (typeof a !== 'boolean' && !isNaN(+a) && !isNaN(+b) && !/:/.test(String(a))) return Math.abs(+a - +b) < 1e-6;
  if (/T\d\d:/.test(String(a)) && /T\d\d:/.test(String(b))) return Math.abs(Date.parse(a) - Date.parse(b)) < 1000;
  return String(a) === String(b);
}

/** New last-lift / SRT for an edited total, anchored to the ORIGINAL prediction time */
function editedTimes(r, newTotal) {
  const delta = newTotal - (+r.total_min || 0);
  let ll;
  if (r.prediction_base_at) ll = addMin(new Date(r.prediction_base_at), newTotal);
  else if (r.predicted_last_lift_at) ll = addMin(new Date(r.predicted_last_lift_at), delta);
  else ll = addMin(recAt(r, 'predicted_last_lift_at', 'predicted_last_lift_time'), Math.round(delta));
  const srt = roundUpTo15(ll);
  return { ll, srt, llHM: toHM(ll), srtHM: toHM(srt) };
}

let EP = null;   // edit-prediction dialog state

function openEditPrediction(r) {
  EP = { r, w: {} };
  const madeAt = r.prediction_base_at ? fmtDT(new Date(r.prediction_base_at))
    : fmtDT(addMin(recAt(r, 'predicted_last_lift_at', 'predicted_last_lift_time'), -Math.round(+r.total_min || 0)));
  const html = `<div class="ep">
    <div class="cf-note"><i class="ti ti-info-circle"></i><div>Recalculated from the original prediction time <b>${esc(madeAt)}</b> — not from now.
      Every edit is marked on the record and logged in the audit trail with your ID and reason.</div></div>
    ${r.actual_last_lift_time ? `<div class="cf-warn"><i class="ti ti-alert-triangle"></i><div>This vessel call is completed. SRT compliance and LL deviation will be re-evaluated against the actual last lift (<b>${esc(r.actual_last_lift_time)}</b>).</div></div>` : ''}
    <div class="grid g2">
      <div class="fld"><label class="k-label fld-label" for="e-qc">Last crane (QC) <span class="req">*</span></label><input id="e-qc" /></div>
      <div class="fld"><label class="k-label fld-label" for="e-cmph">CMPH <span class="req">*</span></label><input id="e-cmph" /></div>
    </div>
    <div class="grid g2 wl ep-wl">
      ${WORKLOAD.map(f => `<div class="fld"><label class="k-label fld-label" for="e-${f.id}">${f.label}</label><input id="e-${f.id}" /></div>`).join('')}
    </div>
    <div class="ep-prev" id="e-prev"></div>
    <div class="fld"><label class="k-label fld-label" for="e-rem">Prediction remarks</label><textarea id="e-rem"></textarea></div>
    <div class="fld"><label class="k-label fld-label" for="e-reason">Reason for edit <span class="req">* recorded in audit trail</span></label><textarea id="e-reason"></textarea><div class="fld-msg" id="e-reason-msg"></div></div>
  </div>`;
  const dlg = openDialog({
    title: `Edit prediction · ${r.vessel_name}`,
    width: 640, cls: 'ep-dialog',
    html,
    actions: [
      { text: 'Cancel' },
      { text: 'Review changes', primary: true, action: () => { reviewEditPrediction(); return false; } }
    ]
  });
  EP.dlg = dlg;
  const w = EP.w;
  w.qc = $('#e-qc').kendoDropDownList({
    dataSource: QC_DB, dataTextField: 'qc', dataValueField: 'qc', optionLabel: 'Select crane…', filter: 'contains', delay: 120, size: 'medium',
    value: r.qc_number || '',
    template: q => `<div class="qc-opt"><b>${esc(q.qc)}</b><span>${esc(q.model || '')} · ${esc(q.speed)} m/min</span></div>`,
    change: () => editPreview()
  }).data('kendoDropDownList');
  typeToSearch(w.qc);
  w.cmph = $('#e-cmph').kendoNumericTextBox({ spinners: false, selectOnFocus: true, min: 1, max: 80, step: 1, decimals: 1, format: '#.#', size: 'medium', value: r.cmph != null ? +r.cmph : null,
    suffixOptions: { template: () => 'moves/hr' }, change: () => editPreview(), spin: () => editPreview() }).data('kendoNumericTextBox');
  $('#e-cmph').on('input', () => editPreview());
  WORKLOAD.forEach(f => {
    w[f.id] = $('#e-' + f.id).kendoNumericTextBox({ spinners: false, selectOnFocus: true, min: 0, step: 1, decimals: 0, format: 'n0', size: 'medium', placeholder: '0', value: r[f.id] != null ? +r[f.id] : null,
      suffixOptions: { template: () => f.unit }, change: () => editPreview(), spin: () => editPreview() }).data('kendoNumericTextBox');
    $('#e-' + f.id).on('input', () => editPreview());
  });
  w.rem = $('#e-rem').kendoTextArea({ rows: 2, maxLength: 500, size: 'medium', value: r.prediction_remarks || '', resize: 'vertical' }).data('kendoTextArea');
  w.reason = $('#e-reason').kendoTextArea({ rows: 2, maxLength: 500, size: 'medium', resize: 'vertical', placeholder: 'e.g. Wrong QC selected; workload corrected after stowage update' }).data('kendoTextArea');
  $('#e-reason').on('input', () => setMsg('e-reason', ''));
  editPreview();
}

/** Builds the update for the current edit form (null if incomplete) */
function editBuild() {
  const { r, w } = EP;
  const f = { qc: w.qc.value(), cmph: readNum(w.cmph) };
  WORKLOAD.forEach(x => { f[x.id] = Math.max(0, readNum(w[x.id])); });
  if (!f.qc || !(f.cmph > 0)) return null;
  const qc = QC_DB.find(q => q.qc === f.qc);
  const speed = qc ? qc.speed : (+r.qc_speed || DEFAULT_QC_SPEED);
  const res = calcPrediction(f, f.cmph, speed);
  const t = editedTimes(r, res.totalMin);
  const upd = {
    qc_number: f.qc, qc_model: qc ? qc.model : (r.qc_model || ''), qc_speed: speed, cmph: +f.cmph,
    f1: f.f1, f2: f.f2, f3: f.f3, f4: f.f4, f5: f.f5, f6: f.f6, f7: f.f7, f8: f.f8,
    container_min: res.containerMin, gantry_min: res.gantryMin, buffer_min: res.bufferMin, total_min: res.totalMin,
    predicted_last_lift_time: t.llHM, suggested_srt: t.srtHM,
    prediction_remarks: String(w.rem.value() || '').trim()
  };
  // keep the full date-time columns in step when the record has them
  if (r.predicted_last_lift_at || r.prediction_base_at) upd.predicted_last_lift_at = t.ll.toISOString();
  if (r.suggested_srt_at || r.prediction_base_at) upd.suggested_srt_at = t.srt.toISOString();
  if (r.actual_last_lift_time) {
    const act = recAt(r, 'actual_last_lift_at', 'actual_last_lift_time', t.ll);
    Object.assign(upd, {
      srt_window_start: toHM(addMin(t.srt, -TARGET.srtWindow)), srt_window_end: t.srtHM,
      srt_class: (act >= addMin(t.srt, -TARGET.srtWindow) && act <= t.srt) ? 'GOOD' : 'NOT QUALITY',
      deviation_minutes: diffMin(t.ll, act)
    });
  }
  const changed = Object.keys(upd).filter(k => !sameVal(r[k], upd[k]));
  return { upd, changed, t, res };
}

function editPreview() {
  if (!EP) return;
  const box = $('#e-prev');
  const b = editBuild();
  if (!b) { box.html('<div class="res-empty sm"><i class="ti ti-hourglass-empty"></i><div>Select a crane and enter CMPH to preview.</div></div>'); return; }
  const r = EP.r;
  const chg = (o, n) => o !== n ? 'chg' : '';
  box.html(`<div class="pred-times">
      <div class="pt"><span>Predicted last lift</span><b class="t-blue ${chg(r.predicted_last_lift_time, b.t.llHM)}">${b.t.llHM}</b><em>${esc(fmtDay(ymd(b.t.ll)))} · was ${esc(r.predicted_last_lift_time)}</em></div>
      <div class="pt srt"><span>Recommended SRT</span><b class="${chg(r.suggested_srt, b.t.srtHM)}">${b.t.srtHM}</b><em>${esc(fmtDay(ymd(b.t.srt)))} · was ${esc(r.suggested_srt)}</em></div>
    </div>
    <div class="kv"><div class="kv-total"><span>Total operation time</span><b>${b.res.totalMin.toFixed(1)} min <span class="muted">· was ${(+r.total_min || 0).toFixed(1)}</span></b></div>
    ${r.actual_last_lift_time ? `<div><span>SRT compliance (re-evaluated)</span><b>${badge(r.srt_class, r.srt_class === 'GOOD' ? 'GOOD' : 'NQ')} → ${badge(b.upd.srt_class, b.upd.srt_class === 'GOOD' ? 'GOOD' : 'NQ')}</b></div>` : ''}</div>`);
}

function reviewEditPrediction() {
  const r = EP.r;
  const b = editBuild();
  if (!b) { toast('Select a crane and enter CMPH.', 'warning'); return; }
  if (!b.changed.length) { toast('Nothing has changed — there is no edit to save.', 'info'); return; }
  const reason = String(EP.w.reason.value() || '').trim();
  if (!reason) { setMsg('e-reason', 'A reason is required for every edit', 'error'); toast('Please enter the reason for this edit.', 'warning'); EP.w.reason.focus(); return; }
  const shown = DIFF_SHOW.filter(k => b.changed.includes(k));
  openDialog({
    title: 'Confirm prediction edit',
    width: 540,
    html: `<div class="dlg-sum">
      <div class="dlg-vessel"><i class="ti ti-ship"></i>${esc(r.vessel_name)} <span>· ${esc(r.vessel_reference)}</span></div>
      <p class="dlg-p muted">These changes will be saved and logged in the audit trail. Tap <b>Amend</b> to go back.</p>
      ${diffTable(shown.map(k => [k, r[k], b.upd[k]]))}
      ${cfSec('Audit entry')}
      ${cfKV('Edited by', esc(S.operator))}
      ${cfKV('Edit no.', String((+r.prediction_edit_count || 0) + 1))}
      ${cfRem(reason)}
    </div>`,
    actions: [
      { text: 'Amend' },
      { text: 'Save edit', primary: true, action: () => { saveEditPrediction(r, b.upd, reason); return true; } }
    ]
  });
}

function diffTable(rows) {
  return `<div class="table-wrap"><table class="k-table k-table-md diff">
    <thead class="k-table-thead"><tr class="k-table-row"><th class="k-table-th">Field</th><th class="k-table-th">Before</th><th class="k-table-th">After</th></tr></thead>
    <tbody class="k-table-tbody">${rows.map(([k, o, n]) => `<tr class="k-table-row"><td class="k-table-td">${esc(AUDIT_LABELS[k] || k)}</td><td class="k-table-td old">${esc(auditVal(k, o))}</td><td class="k-table-td new">${esc(auditVal(k, n))}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

async function saveEditPrediction(r, upd, reason) {
  const payload = Object.assign({}, upd, { edit_reason_input: reason, edit_by_input: S.operator });
  try {
    const { error } = await window.sb.from('vsr_records').update(payload).eq('id', r.id);
    if (error) throw error;
  } catch (e) {
    const missing = e && (e.code === 'PGRST204' || /column|schema cache/i.test(e.message || ''));
    if (missing) openDialog({
      title: 'Audit control not set up', width: 440,
      html: `<div class="cf-warn"><i class="ti ti-alert-triangle"></i><div>The edit was <b>not saved</b>. Run <b>migration_prediction_audit.sql</b> in Supabase → SQL Editor once, then try again.</div></div>`
    });
    else toast('Edit failed: ' + (e.message || e), 'error');
    return;
  }
  if (EP && EP.dlg) EP.dlg.close();
  EP = null;
  toast(`Prediction updated · ${r.vessel_name} — logged in audit trail`, 'success');
  await loadRecords(true);
  refreshCurrentLists();
  const fresh = S.records.find(x => x.id === r.id);
  if (fresh) openRecord(fresh);
}

async function openAuditTrail(r) {
  let rows = [], err = null;
  try {
    const { data, error } = await window.sb.from('vsr_audit_log').select('*').eq('record_id', r.id).order('edited_at', { ascending: false });
    if (error) throw error;
    rows = data || [];
  } catch (e) { err = e; }
  const n = rows.length;
  const body = err
    ? `<div class="cf-warn"><i class="ti ti-alert-triangle"></i><div>Couldn't load the audit trail: ${esc(err.message || err)}<br>Run migration_prediction_audit.sql in Supabase if you haven't yet.</div></div>`
    : !n ? emptyState('ti-history', 'No edits logged', 'This prediction has not been edited.')
    : rows.map((a, i) => {
        const ch = a.changes || {};
        const twin = { predicted_last_lift_at: 'predicted_last_lift_time', suggested_srt_at: 'suggested_srt' };
        const keys = Object.keys(ch).filter(k => !(twin[k] && ch[twin[k]]));   // date-time shown via its HH:mm twin
        return `<div class="audit-entry">
          <div class="ae-h"><b>Edit #${n - i}</b><span>${esc(a.edited_by || '')} · ${esc(fmtDateTime(a.edited_at))}</span></div>
          <div class="d-rem"><i class="ti ti-message-2"></i>${esc(a.reason || '—')}</div>
          ${diffTable(keys.map(k => [k, ch[k] && ch[k].old, ch[k] && ch[k].new]))}
        </div>`;
      }).join('');
  openDialog({
    title: `Audit trail · ${r.vessel_name}`, width: 600,
    html: `<p class="dlg-p muted">${esc(r.vessel_reference)} · original prediction by ${esc(r.prediction_operator || '—')}. Entries are written by the database and cannot be changed from the app.</p>${body}`
  });
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
const csvDT = v => { if (!v) return ''; const d = new Date(v); return ymd(d) + ' ' + toHM(d); };
function downloadReport() {
  const done = dashBase().filter(r => r.actual_last_lift_time);
  if (!done.length) { toast('No completed records to export for the selected filter.', 'warning'); return; }
  const cols = [
    ['id', 'ID'], ['created_at', 'Created At', v => v ? new Date(v).toLocaleString('en-GB') : ''], ['operator_id', 'Operator ID'],
    ['vessel_name', 'Vessel Name'], ['vessel_reference', 'Vessel Reference'],
    ['first_line_time', 'First Line Time'], ['rtw_time', 'RTW Time'], ['first_lift_time', 'First Lift Time'],
    ['first_line_at', 'First Line Date-Time', csvDT], ['rtw_at', 'RTW Date-Time', csvDT], ['first_lift_at', 'First Lift Date-Time', csvDT],
    ['quick_start_minutes', 'Quick Start (min)'], ['quick_start_class', 'Quick Start Class'], ['arrival_remarks', 'Arrival Remarks'],
    ['qc_number', 'QC Number'], ['qc_model', 'QC Model'], ['qc_speed', 'QC Speed (m/min)'], ['cmph', 'CMPH'],
    ['f1', 'Normal Container (Unit)'], ['f2', 'Twin Lift (Unit)'], ['f3', 'Gearbox (Unit)'], ['f4', 'Hatch Cover (Unit)'],
    ['f5', 'OOG (Unit)'], ['f6', 'Open Top (Unit)'], ['f7', 'Gantry Movement (Bay)'], ['f8', 'Breakdown (Min)'],
    ['container_min', 'Container Work Time (min)'], ['gantry_min', 'Gantry Travel Time (min)'], ['buffer_min', 'Breakdown Buffer (min)'],
    ['total_min', 'Total Operation Time (min)'], ['predicted_last_lift_time', 'Predicted Last Lift'], ['suggested_srt', 'Suggested SRT'],
    ['predicted_last_lift_at', 'Predicted Last Lift Date-Time', csvDT], ['suggested_srt_at', 'Suggested SRT Date-Time', csvDT], ['prediction_base_at', 'Prediction Made At', csvDT],
    ['prediction_remarks', 'Prediction Remarks'], ['prediction_operator', 'Prediction Operator'],
    ['prediction_edited', 'Prediction Edited', v => v ? 'YES' : 'NO'], ['prediction_edit_count', 'Prediction Edit Count', v => v || 0],
    ['prediction_last_edited_by', 'Prediction Last Edited By'], ['prediction_last_edited_at', 'Prediction Last Edited At', v => v ? new Date(v).toLocaleString('en-GB') : ''],
    ['prediction_edit_reason', 'Prediction Last Edit Reason'],
    ['actual_last_lift_time', 'Actual Last Lift'], ['actual_pilot_onboard_time', 'Pilot Onboard'], ['actual_srt_time', 'Actual SRT'],
    ['last_line_time', 'Last Line Time'],
    ['actual_last_lift_at', 'Actual Last Lift Date-Time', csvDT], ['pilot_onboard_at', 'Pilot Onboard Date-Time', csvDT],
    ['actual_srt_at', 'Actual SRT Date-Time', csvDT], ['last_line_at', 'Last Line Date-Time', csvDT],
    ['srt_window_start', 'SRT Window Start'], ['srt_window_end', 'SRT Window End'],
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
      const restored = S.operator && loadDrafts();
      renderRoot();
      if (restored) toast('Unsaved entries restored from this device', 'info');
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
