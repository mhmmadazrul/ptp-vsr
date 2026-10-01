let QC_DB = [];

async function loadQCDatabase() {
  try {
    const { data, error } = await window.sb.from('qc_database').select('*').order('qc_number');
    if (error) throw error;
    QC_DB = (data || [])
  .sort((a, b) => {
    const numA = parseInt(a.qc_number.replace(/\D/g, ''));
    const numB = parseInt(b.qc_number.replace(/\D/g, ''));
    return numA - numB;
  })
  .map(r => ({
    qc: r.qc_number,
    model: r.model,
    speed: r.travel_speed_mpm
  }));
  } catch(e) {
    console.error('Failed to load QC database:', e);
    QC_DB = [];
  }
}

const F = { f1:1.0, f2:0.5, f3:1.9157, f4:1.5326, f5:3.0651, f6:1.9157 };

let S = {
  tab: 'arrival',
  operator: localStorage.getItem('ptp_op') || '',
  records: [], loading: false,
  arrForm: { vessel:'', reference:'', remarks:'' },
  predForm: { qc:'', cmph:'', f1:0, f2:0, f3:0, f4:0, f5:0, f6:0, f7:0, f8:0, remarks:'' },
  predResult: null,
  selectedId: null,
  weekFilter: 'all', monthFilter: 'all',
  expandRecId: null
};

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const addMin = (d, m) => new Date(d.getTime() + m * 60000);
const toHM = d => d.toTimeString().slice(0,5);

// ── ISO WEEK / MONTH HELPERS ──
function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}
function getISOWeekYear(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  return d.getUTCFullYear();
}
function getWeekKey(date) {
  return getISOWeekYear(date) + '-W' + String(getISOWeek(date)).padStart(2,'0');
}
function getWeekRange(weekKey) {
  const [yr, wk] = weekKey.split('-W').map(Number);
  const simple = new Date(Date.UTC(yr, 0, 1 + (wk - 1) * 7));
  const dow = simple.getUTCDay() || 7;
  const monday = new Date(simple);
  monday.setUTCDate(simple.getUTCDate() - dow + 1);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { monday, sunday };
}
function formatWeekLabel(weekKey) {
  const { monday, sunday } = getWeekRange(weekKey);
  const fmt = d => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  return weekKey + ' (' + fmt(monday) + ' \u2013 ' + fmt(sunday) + ')';
}
function getMonthKey(date) {
  return date.getFullYear() + '-M' + String(date.getMonth() + 1).padStart(2,'0');
}
function formatMonthLabel(monthKey) {
  const [yr, mo] = monthKey.split('-M').map(Number);
  return new Date(yr, mo - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

// ── SRT ROUND UP TO NEAREST 15 MIN ──
function roundUpTo15(d) {
  const mins = d.getHours() * 60 + d.getMinutes();
  const remainder = mins % 15;
  const roundedMins = remainder === 0 ? mins : mins + (15 - remainder);
  const srt = new Date(d);
  srt.setHours(Math.floor(roundedMins / 60), roundedMins % 60, 0, 0);
  return srt;
}

// ── CLASSIFICATION ──
function classifyQS(mins, target) { return mins <= target ? 'GOOD' : 'NOT QUALITY'; }

// ── DB ──
async function loadRecords() {
  S.loading = true; renderTab();
  try {
    const { data, error } = await window.sb.from('vsr_records').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    S.records = data || [];
  } catch(e) {
    console.error('Load error:', e);
    S.records = [];
  }
  S.loading = false;
  renderTab();
}

// Safety net: if the date-time (*_at) columns haven't been added in Supabase yet,
// retry without them so saving never breaks. Run migration_add_datetimes.sql to enable them.
const isMissingCol = e => e && (e.code === 'PGRST204' || /column|schema cache/i.test(e.message || ''));
const stripAt = o => Object.fromEntries(Object.entries(o).filter(([k]) => !(k.endsWith('_at') && k !== 'created_at')));

async function dbInsert(rec) {
  try {
    let { error } = await window.sb.from('vsr_records').insert([rec]);
    if (isMissingCol(error)) {
      console.warn('Date-time columns missing \u2014 saved without them. Run migration_add_datetimes.sql.');
      ({ error } = await window.sb.from('vsr_records').insert([stripAt(rec)]));
    }
    if (error) throw error;
    return true;
  } catch(e) { toast('Save failed: ' + e.message, 'error'); return false; }
}

async function dbUpdate(id, updates) {
  try {
    let { error } = await window.sb.from('vsr_records').update(updates).eq('id', id);
    if (isMissingCol(error)) {
      console.warn('Date-time columns missing \u2014 saved without them. Run migration_add_datetimes.sql.');
      ({ error } = await window.sb.from('vsr_records').update(stripAt(updates)).eq('id', id));
    }
    if (error) throw error;
    return true;
  } catch(e) { toast('Update failed: ' + e.message, 'error'); return false; }
}

// ── CALC ──
function calcAll(f, cmph, qcSpeed) {
  const base = 60 / cmph;
  let containerMin = 0;
  ['f1','f2','f3','f4','f5','f6'].forEach(id => { containerMin += +(f[id]||0) * base * F[id]; });
  const gantryMin = +(f.f7||0) * 17.5 / qcSpeed;
  const bufferMin = +(f.f8||0);
  return { containerMin, gantryMin, bufferMin, totalMin: containerMin + gantryMin + bufferMin };
}

function syncPredForm() {
  const ids = ['cmph','f1','f2','f3','f4','f5','f6','f7','f8'];
  ids.forEach(id => {
    const el = document.getElementById('p-' + id);
    if (!el) return;
    if (id === 'cmph') S.predForm.cmph = el.value;
    else S.predForm[id] = +el.value || 0;
  });
}

function updatePredHints() {
  syncPredForm();
  const cmph = parseFloat(S.predForm.cmph) || 0;
  const qc = QC_DB.find(q => q.qc === S.predForm.qc);
  const qcSpeed = qc ? qc.speed : 50;
  const base = cmph > 0 ? 60 / cmph : 0;
  const fieldMap = { f1:1.0, f2:0.5, f3:1.9157, f4:1.5326, f5:3.0651, f6:1.9157 };
  Object.entries(fieldMap).forEach(([id, factor]) => {
    const hint = document.getElementById('ph-' + id);
    if (!hint) return;
    const qty = parseFloat(S.predForm[id]) || 0;
    hint.textContent = (cmph && qty) ? (qty * base * factor).toFixed(1) + ' min' : '';
  });
  const hg = document.getElementById('ph-f7');
  if (hg) { const b = parseFloat(S.predForm.f7)||0; hg.textContent = (qcSpeed&&b)?(b*17.5/qcSpeed).toFixed(1)+' min travel':''; }
  const hc = document.getElementById('ph-cmph');
  if (hc) hc.textContent = cmph > 0 ? (60/cmph).toFixed(2)+' min per move' : '';
}

// ── DATE + TIME HELPERS ──
// Each time field carries a date. Dates are pre-filled and inferred automatically:
//  • First field of a group: today (or yesterday if the time would be >60 min in the future).
//  • Later fields: the date that puts the time closest to the previous filled field (±12h).
//    e.g. 23:55 → 00:05 becomes next day; RTW 10:10 → First Lift 10:04 stays same day.
//  • Once the operator picks a date manually, that field is never auto-changed again.
const DT_GROUPS = {
  arr: ['a-fl','a-rtw','a-fli'],
  dep: ['d-ll','d-po','d-srt','d-ll2']
};
let DT = {};   // { fieldId: { date:'YYYY-MM-DD', manual:bool } }

const pad2 = n => String(n).padStart(2,'0');
const ymd = d => d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate());
const shiftYmd = (s, days) => { const d = new Date(s + 'T12:00'); d.setDate(d.getDate() + days); return ymd(d); };
const mkDT = (dateStr, hm) => new Date(dateStr + 'T' + hm);
const diffMin = (a, b) => Math.round((b - a) / 60000);          // b − a in minutes (Date objects)
const WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtDay = s => { const d = new Date(s + 'T12:00'); return WD[d.getDay()] + ' ' + d.getDate() + ' ' + MO[d.getMonth()]; };
const fmtDT = d => toHM(d) + ' \u00b7 ' + d.getDate() + ' ' + MO[d.getMonth()];

// Pick the calendar date that places hm nearest to the anchor Date
function nearestDate(hm, anchor) {
  const base = ymd(anchor);
  let best = base, bestGap = Infinity;
  [-1, 0, 1].forEach(k => {
    const d = shiftYmd(base, k);
    const gap = Math.abs(mkDT(d, hm) - anchor);
    if (gap < bestGap) { bestGap = gap; best = d; }
  });
  return best;
}

function groupOf(id) { return Object.keys(DT_GROUPS).find(g => DT_GROUPS[g].includes(id)); }

function initDTGroup(g) { DT_GROUPS[g].forEach(id => { DT[id] = { date: ymd(new Date()), manual: false }; }); }

// Re-infer every non-manual date in a group, in field order
function dtSync(g) {
  let anchor = null;
  DT_GROUPS[g].forEach(id => {
    const st = DT[id] || (DT[id] = { date: ymd(new Date()), manual: false });
    const hm = readHM(id);
    if (!st.manual) {
      const prev = st.date;
      if (hm && anchor) st.date = nearestDate(hm, anchor);
      else if (hm) {
        const today = ymd(new Date());
        st.date = (mkDT(today, hm) - new Date() > 60 * 60000) ? shiftYmd(today, -1) : today;
      } else st.date = anchor ? ymd(anchor) : ymd(new Date());
      if (prev !== st.date) st.flash = true;
    }
    if (hm) anchor = mkDT(st.date, hm);
  });
  DT_GROUPS[g].forEach(paintChip);
}

function paintChip(id) {
  const el = document.getElementById(id + '-dc');
  const st = DT[id];
  if (!el || !st) return;
  const g = groupOf(id);
  const ref = DT[DT_GROUPS[g][0]].date;
  const delta = Math.round((new Date(st.date + 'T12:00') - new Date(ref + 'T12:00')) / 86400000);
  const shifted = delta !== 0 && DT_GROUPS[g][0] !== id;
  el.innerHTML = `<i class="ti ti-calendar"></i>${fmtDay(st.date)}${shifted ? `<span class="dchip-d">${delta>0?'+':''}${delta}d</span>` : ''}`;
  el.classList.toggle('shifted', shifted);
  el.title = st.manual ? 'Date set manually — tap to change' : 'Date auto-filled — tap to change';
  if (st.flash) {
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    st.flash = false;
  }
}

// Date chip popover: Yesterday / Today / Tomorrow / Pick date…
window.openDatePop = function(id, ev) {
  ev && ev.stopPropagation();
  closeDatePop();
  const chip = document.getElementById(id + '-dc');
  const today = ymd(new Date());
  const opts = [['Yesterday', shiftYmd(today,-1)], ['Today', today], ['Tomorrow', shiftYmd(today,1)]];
  const pop = document.createElement('div');
  pop.className = 'dpop'; pop.id = 'dpop';
  pop.innerHTML = opts.map(([lbl, d]) =>
    `<button type="button" class="${DT[id].date===d?'on':''}" onclick="setDTDate('${id}','${d}')">${lbl}<span>${fmtDay(d)}</span></button>`
  ).join('') +
    `<label class="dpop-pick"><i class="ti ti-calendar-search"></i>Pick date…
      <input type="date" value="${DT[id].date}" onclick="try{this.showPicker()}catch(e){}" onchange="if(this.value)setDTDate('${id}',this.value)"></label>` +
    (DT[id].manual ? `<button type="button" class="dpop-auto" onclick="resetDTDate('${id}')"><i class="ti ti-wand"></i>Back to auto</button>` : '');
  document.body.appendChild(pop);
  const r = chip.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.top = (window.scrollY + r.bottom + 4) + 'px';
  pop.style.left = Math.max(8, Math.min(window.scrollX + r.right - w, window.scrollX + document.documentElement.clientWidth - w - 8)) + 'px';
};
window.closeDatePop = function() { document.getElementById('dpop')?.remove(); };
window.setDTDate = function(id, d) { DT[id].date = d; DT[id].manual = true; closeDatePop(); dtSync(groupOf(id)); };
window.resetDTDate = function(id) { DT[id].manual = false; closeDatePop(); dtSync(groupOf(id)); };
document.addEventListener('click', e => { if (!e.target.closest('#dpop')) closeDatePop(); });
window.addEventListener('resize', () => closeDatePop());

// Read a field as { hm:'HH:MM', date:'YYYY-MM-DD', dt:Date } or null
function readDT(id) {
  const hm = readHM(id);
  if (!hm) return null;
  const date = (DT[id] && DT[id].date) || ymd(new Date());
  return { hm, date, dt: mkDT(date, hm) };
}

// Datetime of a stored record field; legacy rows (no *_at) are inferred near an anchor
function recDT(r, atKey, hmKey, anchor) {
  if (r[atKey]) return new Date(r[atKey]);
  if (!r[hmKey]) return null;
  const a = anchor || new Date(r.created_at);
  return mkDT(nearestDate(r[hmKey], a), r[hmKey]);
}

// ── KENDO UI HELPERS ──
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const escBr = s => esc(s).replace(/\n/g, '<br>');
// Kendo rendering classes (Default theme, recoloured to PTP palette in style.css)
const IN = 'k-input k-input-md k-input-solid k-rounded-md iw';
const TA = 'k-input k-textarea k-input-md k-input-solid k-rounded-md';
const kBtn = (theme = 'primary', size = 'lg', fill = 'solid') => `k-button k-button-${size} k-button-${fill} k-button-${theme} k-rounded-md`;
const badge = c => `<span class="badge ${c === 'GOOD' ? 'bg' : 'bb'}">${esc(c)}</span>`;
const row = (label, val, style = '') => `<div class="rrow"${style ? ` style="${style}"` : ''}><span>${label}</span><span class="rval">${val}</span></div>`;
const remRow = (label, txt) => `<div class="rrow"><span>${label}</span><span class="cf-rem">${txt ? escBr(txt) : '<span style="color:#6b6b67">—</span>'}</span></div>`;

// Keep the caret where it was while forcing capitals
window.upperIn = function(inp) {
  const s = inp.selectionStart, e = inp.selectionEnd, u = inp.value.toUpperCase();
  if (u !== inp.value) { inp.value = u; try { inp.setSelectionRange(s, e); } catch (_) {} }
  return u;
};

// Toast notifications (replace browser alerts)
let _notif = null;
function toast(msg, type = 'info') {
  if (!window.kendo || !window.jQuery) { alert(msg); return; }
  if (!_notif) {
    if (!document.getElementById('toast-host')) $('<div id="toast-host" aria-live="polite"></div>').appendTo('body');
    _notif = $('<span id="k-notif"></span>').appendTo('body').kendoNotification({
      appendTo: '#toast-host', stacking: 'up', autoHideAfter: 4500, button: true, hideOnClick: true
    }).data('kendoNotification');
  }
  _notif.show(escBr(msg), type);
}

// Modal dialog. actions: [{ text, icon, theme:'primary'|'success'|'base', onClick(dlg) → false | Promise<bool> }]
function kDialog({ title, icon = 'ti-info-circle', html, actions = [{ text: 'OK', theme: 'primary' }], width = 480, closable = true, onClose }) {
  const $el = $('<div></div>').appendTo('body');
  let dlg;
  const busy = (on, label) => {
    const $btns = $el.closest('.k-dialog').find('.k-dialog-actions .k-button');
    $btns.prop('disabled', on);
    if (label) $btns.filter('.is-main').find('.lbl').text(label);
  };
  dlg = $el.kendoDialog({
    width: Math.min(width, window.innerWidth - 16) + 'px',
    title: title, closable, modal: true, content: html,
    actions: actions.map(a => ({
      text: a.text,
      action: () => {
        if (!a.onClick) return true;
        const r = a.onClick(dlg);
        if (r && typeof r.then === 'function') {
          busy(true, a.busyText || 'Saving\u2026');
          r.then(ok => { if (ok !== false) dlg.close(); else busy(false, a.text); })
           .catch(err => { console.error(err); busy(false, a.text); });
          return false;
        }
        return r !== false;
      }
    })),
    close: () => { onClose && onClose(); },
    hide: () => setTimeout(() => { try { dlg.destroy(); } catch (_) {} $el.remove(); }, 0)
  }).data('kendoDialog');
  const $w = $el.closest('.k-dialog');
  $w.find('.k-window-title, .k-dialog-title').first().html(`<i class="ti ${icon}"></i>${esc(title)}`);
  $w.find('.k-dialog-actions .k-button').each((i, b) => {
    const a = actions[i]; if (!a) return;
    const theme = a.theme || 'base';
    b.className = `k-button k-button-md k-button-solid k-button-${theme} k-rounded-md` + (theme !== 'base' ? ' is-main' : '');
    b.innerHTML = (a.icon ? `<i class="ti ${a.icon}"></i>` : '') + `<span class="lbl">${esc(a.text)}</span>`;
  });
  dlg.open();
  return dlg;
}

function kAlert(title, msg, icon = 'ti-alert-triangle') {
  return kDialog({ title, icon, html: `<div class="cf-note warn" style="margin-top:0"><i class="ti ti-alert-triangle"></i><div>${escBr(msg)}</div></div>`,
    actions: [{ text: 'OK, let me fix it', theme: 'primary' }], width: 420 });
}

// Searchable dropdown for vessel records (type to filter by vessel name or reference)
function vesselDDL(selector, records, metaFn, onPick) {
  const el = document.querySelector(selector);
  if (!el || !window.kendo) return;
  const data = records.map(r => ({ id: r.id, text: r.vessel_name + ' \u00b7 ' + r.vessel_reference, vessel: r.vessel_name, ref: r.vessel_reference, meta: metaFn(r) }));
  $(el).kendoDropDownList({
    dataSource: data, dataTextField: 'text', dataValueField: 'id',
    filter: 'contains', ignoreCase: true,
    optionLabel: '\u2014 select or search vessel \u2014',
    value: records.some(r => r.id === S.selectedId) ? S.selectedId : '',
    height: 320,
    template: d => `<div class="ddl-item"><b>${esc(d.vessel)} <span style="font-weight:400;opacity:.75">\u00b7 ${esc(d.ref)}</span></b><small>${esc(d.meta)}</small></div>`,
    noDataTemplate: () => '<div style="padding:12px;color:#6b6b67;font-size:12px">No vessel matches your search</div>',
    change: function() { const v = this.value(); setTimeout(() => onPick(v), 0); }
  });
  const ddl = $(el).data('kendoDropDownList');
  ddl.filterInput && ddl.filterInput.attr('placeholder', 'Type vessel name or reference\u2026');
}

function qcDDL(selector, value, onPick) {
  const el = document.querySelector(selector);
  if (!el || !window.kendo) return;
  $(el).kendoDropDownList({
    dataSource: QC_DB.map(q => ({ ...q, text: q.qc })), dataTextField: 'text', dataValueField: 'qc',
    filter: 'contains', optionLabel: '\u2014 select QC \u2014', value: value || '', height: 300,
    template: d => `<div class="ddl-item"><b>${esc(d.qc)}</b><small>${esc(d.model || '')}${d.speed ? ' \u00b7 ' + d.speed + ' m/min' : ''}</small></div>`,
    change: function() { const v = this.value(); setTimeout(() => onPick(v), 0); }
  });
}

// Run fn once a dropdown's popup has finished closing (safe to destroy/re-render the widget then)
function afterClose(w, fn) {
  const pop = w && w.popup;
  if (pop && (pop.visible() || pop._closing)) pop.one('deactivate', () => setTimeout(fn, 0));
  else setTimeout(fn, 0);
}

function kDestroy(el) { if (el && window.kendo) { try { kendo.destroy(el); } catch (_) {} } }

// ── TIME INPUT ──
function fieldTime(id, label) {
  return `<div class="fi">
    <div class="lrow"><label>${label}</label>
      <button type="button" class="dchip" id="${id}-dc" onclick="openDatePop('${id}',event)"></button></div>
    ${hhInput(id)}
  </div>`;
}

function hhInput(id) {
  return `<span class="${IN}" style="gap:0">
    <input type="number" inputmode="numeric" class="k-input-inner" id="${id}-h" placeholder="HH" min="0" max="23" maxlength="2" style="text-align:center;flex:1" oninput="hhAdv(this,'${id}-m');onTimeInput('${id}')">
    <span style="padding:0 4px;color:#6b6b67;font-size:16px;flex-shrink:0">:</span>
    <input type="number" inputmode="numeric" class="k-input-inner" id="${id}-m" placeholder="MM" min="0" max="59" maxlength="2" style="text-align:center;flex:1" oninput="onTimeInput('${id}')">
  </span>`;
}

window.onTimeInput = function(id) { const g = groupOf(id); if (g) dtSync(g); };

function readHM(id) {
  const h = document.getElementById(id+'-h')?.value;
  const m = document.getElementById(id+'-m')?.value;
  if (h===''||h===null||h===undefined||m===''||m===null||m===undefined) return null;
  return String(Math.min(23,Math.max(0,+h))).padStart(2,'0') + ':' + String(Math.min(59,Math.max(0,+m))).padStart(2,'0');
}

window.hhAdv = function(inp, nextId) {
  if (inp.value.length >= 2) {
    inp.value = Math.min(23, Math.max(0, +inp.value));
    const el = document.getElementById(nextId);
    if (el) el.focus();
  }
};

// ── RENDER ──
function R() {
  const root = document.getElementById('root');
  if (!root) return;
  kDestroy(root);
  root.innerHTML = '';
  if (!S.operator) { renderLogin(root); return; }
  renderApp(root);
}

function renderLogin(root) {
  root.innerHTML = `<div class="login-wrap">
  <div class="card" style="text-align:center">
    <i class="ti ti-ship" style="font-size:36px;color:#185FA5"></i>
    <div style="font-weight:600;font-size:16px;margin:12px 0 4px">PTP Vessel Status Report</div>
    <div style="font-size:13px;color:#6b6b67;margin-bottom:20px">Port of Tanjung Pelepas</div>
    <div class="fi" style="margin-bottom:14px;text-align:left">
      <label for="op-inp">Employee ID</label>
      <span class="${IN}"><input id="op-inp" class="k-input-inner upper" placeholder="e.g. 0XXXX0" autocomplete="off" oninput="upperIn(this)" onkeydown="if(event.key==='Enter')doLogin()"></span>
    </div>
    <button class="btn ${kBtn()}" onclick="doLogin()"><i class="ti ti-login-2"></i>Enter system</button>
  </div></div>`;
}

function renderApp(root) {
  const pending = S.records.filter(r => !r.actual_last_lift_time);
  root.innerHTML = `
  <div class="topbar">
    <i class="ti ti-ship" style="font-size:20px;color:#185FA5;flex-shrink:0"></i>
    <span class="topbar-title">PTP Vessel Status Report</span>
    <span class="topbar-sub">Port of Tanjung Pelepas</span>
    <span style="margin-left:auto;font-size:11px;color:#6b6b67;display:flex;align-items:center;gap:6px;flex-shrink:0">
      <i class="ti ti-user" style="font-size:13px"></i>${esc(S.operator)}
      <button class="btn-sm btn-xs ${kBtn('base','sm','outline')}" onclick="doLogout()">change</button>
    </span>
  </div>
  <div class="nav">
    <button class="${S.tab==='arrival'?'active':''}" onclick="setTab('arrival')"><i class="ti ti-anchor"></i>Arrival</button>
    <button class="${S.tab==='prediction'?'active':''}" onclick="setTab('prediction')"><i class="ti ti-calculator"></i>Dep. Prediction<span class="cnt">${pending.filter(r=>!r.predicted_last_lift_time).length}</span></button>
    <button class="${S.tab==='actual'?'active':''}" onclick="setTab('actual')"><i class="ti ti-clipboard-check"></i>Actual Dep.<span class="cnt">${pending.filter(r=>r.predicted_last_lift_time).length}</span></button>
    <button class="${S.tab==='records'?'active':''}" onclick="setTab('records')"><i class="ti ti-clipboard-list"></i>Records<span class="cnt">${S.records.length}</span></button>
    <button class="${S.tab==='dashboard'?'active':''}" onclick="setTab('dashboard')"><i class="ti ti-chart-bar"></i>Dashboard</button>
  </div>
  <div id="tab-body"></div>`;
  renderTab();
}

function renderTab() {
  const tb = document.getElementById('tab-body');
  if (!tb) return;
  kDestroy(tb);
  if (S.tab==='arrival') renderArrival(tb);
  else if (S.tab==='prediction') renderPrediction(tb);
  else if (S.tab==='actual') renderActual(tb);
  else if (S.tab==='records') renderRecords(tb);
  else renderDashboard(tb);
}

const emptyArr = () => ({ vessel:'', reference:'', remarks:'' });
const emptyPred = () => ({ qc:'', cmph:'', f1:0, f2:0, f3:0, f4:0, f5:0, f6:0, f7:0, f8:0, remarks:'' });

// ── PHASE 1: ARRIVAL ──
function renderArrival(tb) {
  const f = S.arrForm;
  tb.innerHTML = `
  <div class="card">
    <div class="ctitle">Vessel information</div>
    <div class="g2" style="margin-bottom:9px">
      <div class="fi"><label for="a-vessel">Vessel name</label>
        <span class="${IN}"><input id="a-vessel" class="k-input-inner upper" value="${esc(f.vessel)}" placeholder="e.g. EVER GIVEN" autocomplete="off" oninput="S.arrForm.vessel=upperIn(this)"></span>
      </div>
      <div class="fi"><label for="a-ref">Vessel reference</label>
        <span class="${IN}"><input id="a-ref" class="k-input-inner upper" value="${esc(f.reference)}" placeholder="e.g. VOY-2025-001" autocomplete="off" oninput="S.arrForm.reference=upperIn(this)"></span>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="ctitle">Arrival times</div>
    <div class="g3" style="margin-bottom:9px">
      ${fieldTime('a-fl','First line')}
      ${fieldTime('a-rtw','Vessel secured (RTW)')}
      ${fieldTime('a-fli','First lift')}
    </div>
    <div class="info-box" style="margin-bottom:9px">
      Quick Start = First Lift \u2212 RTW &nbsp;\u00b7&nbsp; Target \u2264 20 min<br>
      <strong>\u26a0\ufe0f First Line must not be later than RTW.</strong> First Lift before RTW is allowed (Quick Start goes negative).<br>
      <span style="opacity:.8">Dates fill in automatically, including past midnight. Tap a date to change it.</span>
    </div>
    <div class="fi" style="margin-bottom:9px">
      <label for="a-rem">Remarks <span style="font-size:10px;color:#6b6b67">(mandatory)</span></label>
      <span class="${TA}"><textarea id="a-rem" class="k-input-inner" rows="2" placeholder="Any notes about the arrival..." oninput="S.arrForm.remarks=this.value">${esc(f.remarks)}</textarea></span>
    </div>
    <button class="btn ${kBtn()}" onclick="calcArrival()"><i class="ti ti-calculator"></i>Calculate arrival</button>
  </div>`;
  initDTGroup('arr');
  dtSync('arr');
}

window.calcArrival = function() {
  const vessel = document.getElementById('a-vessel')?.value.trim().toUpperCase();
  const ref = document.getElementById('a-ref')?.value.trim().toUpperCase();
  const rem = document.getElementById('a-rem')?.value.trim();
  const fl = readDT('a-fl');
  const rtw = readDT('a-rtw');
  const fli = readDT('a-fli');
  if (!vessel) { toast('Please enter vessel name.', 'warning'); return; }
  if (!ref) { toast('Please enter vessel reference.', 'warning'); return; }
  if (!fl||!rtw||!fli) { toast('Please enter all three arrival times.', 'warning'); return; }
  if (!rem) { toast('Remarks are mandatory.', 'warning'); document.getElementById('a-rem')?.focus(); return; }

  // ── POKA YOKE: First Line ≤ RTW (date-aware). First Lift may precede RTW (negative Quick Start). ──
  if (rtw.dt < fl.dt) {
    kAlert('Poka Yoke check', 'Vessel Secured / RTW (' + fmtDT(rtw.dt) + ') cannot be earlier than First Line (' + fmtDT(fl.dt) + ').\nPlease check the times and dates.');
    return;
  }

  const qs = diffMin(rtw.dt, fli.dt);
  const pending = { vessel, reference: ref, remarks: rem,
    first_line: fl.hm, rtw: rtw.hm, first_lift: fli.hm,
    first_line_at: fl.dt.toISOString(), rtw_at: rtw.dt.toISOString(), first_lift_at: fli.dt.toISOString(),
    quick_start: qs, qs_class: classifyQS(qs, 20) };

  kDialog({
    title: 'Confirm arrival details', icon: 'ti-anchor',
    html: `<div class="cf-lead">Please check the details below. Tap <b>Amend</b> to go back and correct anything.</div>
      <div class="cf-sec">Vessel</div>
      <div class="rbox">${row('Vessel name', esc(vessel))}${row('Vessel reference', esc(ref))}</div>
      <div class="cf-sec">Arrival times</div>
      <div class="rbox">${row('First line', fmtDT(fl.dt))}${row('Vessel secured (RTW)', fmtDT(rtw.dt))}${row('First lift', fmtDT(fli.dt))}</div>
      <div class="cf-sec">Remarks</div>
      <div class="rbox" style="white-space:pre-wrap;font-size:13px">${escBr(rem)}</div>
      ${qs < 0 ? `<div class="cf-note warn"><i class="ti ti-info-circle"></i><div>First Lift is ${-qs} min before RTW \u2014 a negative Quick Start will be recorded. Make sure your remarks explain why.</div></div>` : ''}`,
    actions: [
      { text: 'Amend', icon: 'ti-pencil', theme: 'base' },
      { text: 'Calculate & save', icon: 'ti-device-floppy', theme: 'success', onClick: () => saveArrival(pending) }
    ]
  });
};

async function saveArrival(f) {
  const rec = {
    id: genId(),
    vessel_name: f.vessel,
    vessel_reference: f.reference,
    first_line_time: f.first_line,
    rtw_time: f.rtw,
    first_lift_time: f.first_lift,
    first_line_at: f.first_line_at,
    rtw_at: f.rtw_at,
    first_lift_at: f.first_lift_at,
    quick_start_minutes: f.quick_start,
    quick_start_class: f.qs_class,
    arrival_remarks: f.remarks,
    operator_id: S.operator,
    created_at: new Date().toISOString()
  };
  const ok = await dbInsert(rec);
  if (!ok) return false;
  S.arrForm = emptyArr();
  const good = rec.quick_start_class === 'GOOD';
  setTimeout(() => kDialog({
    title: 'Arrival saved', icon: 'ti-circle-check',
    html: `<div class="cf-result-head"><div class="ico ${good?'ok':'bad'}"><i class="ti ti-${good?'check':'alert-triangle'}"></i></div>
        <div><div class="t1">${esc(rec.vessel_name)}</div><div class="t2">${esc(rec.vessel_reference)}</div></div></div>
      <div class="rbox">${row('Quick Start (First Lift \u2212 RTW)', rec.quick_start_minutes + ' min &nbsp;' + badge(rec.quick_start_class), 'font-weight:500')}
        ${row('Target', '\u2264 20 min')}</div>`,
    actions: [{ text: 'Next: Departure Prediction', icon: 'ti-arrow-right', theme: 'primary' }],
    onClose: () => { S.tab = 'prediction'; S.selectedId = rec.id; S.predForm = emptyPred(); loadRecords().then(() => R()); }
  }), 50);
  return true;
}

// ── PHASE 2: DEPARTURE PREDICTION ──
const WORKLOAD = [
  ['f1','Normal container','Unit',1.0], ['f2','Twin lift','Unit',0.5], ['f3','Gearbox','Unit',1.9157],
  ['f4','Hatch cover','Unit',1.5326], ['f5','OOG','Unit',3.0651], ['f6','Open top','Unit',1.9157]
];

function renderPrediction(tb) {
  const pending = S.records.filter(r => !r.predicted_last_lift_time);
  tb.innerHTML = `
  <div class="card">
    <div class="ctitle">Select vessel</div>
    ${!pending.length ? '<div class="empty">No pending arrival records. Complete an arrival first.</div>' : `
    <div class="fi">
      <label for="sel-record">Vessel <span style="font-size:10px;color:#6b6b67">(${pending.length} awaiting prediction · type to search)</span></label>
      <input id="sel-record" style="width:100%">
    </div>
    <div id="pred-sel-info"></div>`}
  </div>
  <div id="pred-body"></div>`;
  if (pending.length) vesselDDL('#sel-record', pending,
    r => 'Arrived ' + new Date(r.created_at).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) + ' · QS ' + r.quick_start_minutes + ' min',
    v => { if ((v || null) !== S.selectedId) { S.selectedId = v || null; S.predForm = emptyPred(); renderPredBody(); } });
  renderPredBody();
}

// Everything below the vessel picker (re-rendered on vessel change without rebuilding the picker)
function renderPredBody() {
  const body = document.getElementById('pred-body');
  const info = document.getElementById('pred-sel-info');
  if (!body) return;
  kDestroy(body);
  const sel = S.records.find(r => r.id === S.selectedId && !r.predicted_last_lift_time) || null;
  if (info) info.innerHTML = sel ? `<div class="rbox" style="margin-top:8px">
        ${row('Vessel', esc(sel.vessel_name))}
        ${row('Reference', esc(sel.vessel_reference))}
        ${row('Vessel secured (RTW)', showAt(sel,'rtw_at','rtw_time'))}
        ${row('Quick Start', sel.quick_start_minutes + ' min ' + badge(sel.quick_start_class))}
      </div>` : '';
  if (!sel) { body.innerHTML = ''; return; }
  const f = S.predForm;
  const qc = QC_DB.find(q => q.qc === f.qc);
  const qcSpeed = qc ? qc.speed : null;
  const cmph = parseFloat(f.cmph) || 0;
  const base = cmph > 0 ? 60 / cmph : 0;
  const mini = (id, factor) => { const qty = parseFloat(f[id])||0; return (cmph&&qty)?(qty*base*factor).toFixed(1)+' min':''; };
  const numIn = (id, unit, hint) => `
        <span class="${IN}"><input id="p-${id}" class="k-input-inner" type="number" inputmode="decimal" value="${f[id]||''}" placeholder="Quantity" min="0" oninput="updatePredHints()"><span class="k-input-suffix utag">${unit}</span></span>
        <div id="ph-${id}" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${hint}</div>`;

  body.innerHTML = `
  <div class="card">
    <div class="ctitle">Crane setup</div>
    <div class="g2" style="margin-bottom:9px">
      <div class="fi"><label for="p-qc">QC number (Last crane) <span style="font-size:10px;color:#6b6b67">· type to search</span></label>
        <input id="p-qc" style="width:100%">
        <div id="qc-info" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${qc?`${esc(qc.model)} · ${qc.speed} m/min`:''}</div>
      </div>
      <div class="fi"><label for="p-cmph">CMPH</label>
        <span class="${IN}"><input id="p-cmph" class="k-input-inner" type="number" inputmode="decimal" value="${f.cmph}" placeholder="e.g. 28" min="1" max="60" oninput="updatePredHints()"></span>
        <div id="ph-cmph" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${cmph>0?(60/cmph).toFixed(2)+' min per move':''}</div>
      </div>
    </div>
    <div id="qc-speed-wrap">${qcSpeedField(qcSpeed)}</div>
  </div>

  <div class="card">
    <div class="ctitle">Container workload</div>
    <div class="g2" style="margin-bottom:9px">
      ${WORKLOAD.map(([id,label,unit,factor]) => `<div class="fi"><label for="p-${id}">${label}</label>${numIn(id, unit, mini(id, factor))}</div>`).join('')}
    </div>
    <div class="g2">
      <div class="fi"><label for="p-f7">Gantry movement</label>${numIn('f7','Bay',(qcSpeed&&f.f7>0)?((+f.f7*17.5/qcSpeed).toFixed(1)+' min travel'):'')}</div>
      <div class="fi"><label for="p-f8">Breakdown</label>
        <span class="${IN}"><input id="p-f8" class="k-input-inner" type="number" inputmode="decimal" value="${f.f8||''}" placeholder="Quantity" min="0"><span class="k-input-suffix utag">Min</span></span>
        <div style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">Added to total time</div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="fi" style="margin-bottom:9px">
      <label for="pred-rem">Remarks <span style="font-size:10px;opacity:.6">(optional)</span></label>
      <span class="${TA}"><textarea id="pred-rem" class="k-input-inner" rows="2" placeholder="Any notes or assumptions..." oninput="S.predForm.remarks=this.value">${esc(f.remarks||'')}</textarea></span>
    </div>
    <button class="btn ${kBtn()}" onclick="doPredCalc()"><i class="ti ti-calculator"></i>Calculate prediction</button>
  </div>`;
  qcDDL('#p-qc', f.qc, v => onPredQC(v));
}

const qcSpeedField = sp => sp ? `<div class="fi" style="margin-bottom:9px"><label>QC travel speed</label><span class="${IN} is-readonly"><input class="k-input-inner" value="${(+sp).toFixed(1)} m/min" readonly></span></div>` : '';


// Stored time with its date when available (records saved before dates show time only)
function showAt(r, atKey, hmKey) {
  if (r[atKey]) return fmtDT(new Date(r[atKey]));
  return esc(r[hmKey] || '');
}

// Small date line under a big time, shown only when it isn't today
function dayTag(iso) {
  const d = new Date(iso);
  if (ymd(d) === ymd(new Date())) return '';
  return `<div class="daytag">${fmtDay(ymd(d))}</div>`;
}

// Prediction maths from a base time (time the prediction is made)
function computePrediction(f, base) {
  const qc = QC_DB.find(q => q.qc === f.qc);
  const speed = qc ? qc.speed : (+f.qc_speed || 50);
  const res = calcAll(f, +f.cmph, speed);
  const lastLift = addMin(base, res.totalMin);
  const srt = roundUpTo15(lastLift);
  return { ...res, qc, speed, lastLift, srt, lastLiftStr: toHM(lastLift), srtStr: toHM(srt),
    lastLiftAt: lastLift.toISOString(), srtAt: srt.toISOString() };
}

// SRT compliance + deviation from an actual last lift
function srtEval(srtAt, predAt, srtHM, llDt) {
  return {
    srt_window_start: toHM(addMin(srtAt, -15)),
    srt_window_end: srtHM,
    srt_class: (llDt >= addMin(srtAt, -15) && llDt <= srtAt) ? 'GOOD' : 'NOT QUALITY',
    deviation_minutes: diffMin(predAt, llDt)
  };
}

// QC change updates the hints in place (no re-render, so the dropdown isn't torn down mid-close)
window.onPredQC = function(v) {
  syncPredForm(); S.predForm.qc = v;
  const qc = QC_DB.find(q => q.qc === v);
  const info = document.getElementById('qc-info'); if (info) info.textContent = qc ? `${qc.model} \u00b7 ${qc.speed} m/min` : '';
  const sw = document.getElementById('qc-speed-wrap'); if (sw) sw.innerHTML = qcSpeedField(qc && qc.speed);
  updatePredHints();
};

function workloadRows(f, cmph) {
  const base = cmph > 0 ? 60 / cmph : 0;
  const rows = WORKLOAD.filter(([id]) => +f[id] > 0).map(([id,label,unit,factor]) =>
    row(label, `${+f[id]} ${unit.toLowerCase()} \u00b7 ${(+f[id]*base*factor).toFixed(1)} min`));
  if (+f.f7 > 0) rows.push(row('Gantry movement', `${+f.f7} bay`));
  if (+f.f8 > 0) rows.push(row('Breakdown', `${+f.f8} min`));
  return rows.length ? rows.join('') : row('Workload', '<span style="color:#A32D2D">none entered</span>');
}

window.doPredCalc = function() {
  syncPredForm();
  const f = S.predForm;
  f.remarks = document.getElementById('pred-rem')?.value || '';
  const r = S.records.find(x => x.id === S.selectedId);
  if (!r) { toast('Please select a vessel.', 'warning'); return; }
  if (!f.qc) { toast('Please select a QC number.', 'warning'); return; }
  if (!f.cmph||+f.cmph<=0) { toast('Please enter CMPH.', 'warning'); return; }
  const qc = QC_DB.find(q=>q.qc===f.qc);
  const est = calcAll(f, +f.cmph, qc ? qc.speed : 50);
  const snapshot = { ...f };

  kDialog({
    title: 'Confirm prediction details', icon: 'ti-calculator', width: 500,
    html: `<div class="cf-lead">Please check the details below. Tap <b>Amend</b> to go back and correct anything.</div>
      <div class="cf-sec">Vessel</div>
      <div class="rbox">${row('Vessel', esc(r.vessel_name))}${row('Reference', esc(r.vessel_reference))}</div>
      <div class="cf-sec">Crane setup</div>
      <div class="rbox">${row('QC number', esc(f.qc) + (qc ? ` <span style="font-weight:400;color:#6b6b67">\u00b7 ${esc(qc.model)} \u00b7 ${qc.speed} m/min</span>` : ''))}
        ${row('CMPH', `${+f.cmph} <span style="font-weight:400;color:#6b6b67">\u00b7 ${(60/+f.cmph).toFixed(2)} min/move</span>`)}</div>
      <div class="cf-sec">Container workload</div>
      <div class="rbox">${workloadRows(f, +f.cmph)}
        ${row('Total operation time', `${est.totalMin.toFixed(1)} min \u00b7 ${(est.totalMin/60).toFixed(2)} hrs`, 'font-weight:500')}</div>
      ${f.remarks.trim() ? `<div class="cf-sec">Remarks</div><div class="rbox" style="white-space:pre-wrap;font-size:13px">${escBr(f.remarks.trim())}</div>` : ''}
      <div class="cf-note"><i class="ti ti-clock"></i><div>Predicted last lift = the moment you tap <b>Calculate &amp; save</b> + total operation time. SRT is rounded up to the next 15-min mark.</div></div>`,
    actions: [
      { text: 'Amend', icon: 'ti-pencil', theme: 'base' },
      { text: 'Calculate & save', icon: 'ti-device-floppy', theme: 'success', onClick: () => savePrediction(r.id, snapshot) }
    ]
  });
};

async function savePrediction(id, f) {
  const now = new Date();
  const p = computePrediction(f, now);
  const rem = (f.remarks || '').trim();
  const ok = await dbUpdate(id, {
    qc_number: f.qc, qc_model: p.qc?.model||'', qc_speed: p.qc?.speed||50, cmph: +f.cmph,
    f1:+f.f1,f2:+f.f2,f3:+f.f3,f4:+f.f4,f5:+f.f5,f6:+f.f6,f7:+f.f7,f8:+f.f8,
    container_min: p.containerMin, gantry_min: p.gantryMin, buffer_min: p.bufferMin, total_min: p.totalMin,
    predicted_last_lift_time: p.lastLiftStr, suggested_srt: p.srtStr,
    predicted_last_lift_at: p.lastLiftAt, suggested_srt_at: p.srtAt, prediction_base_at: now.toISOString(),
    prediction_remarks: rem, prediction_operator: S.operator
  });
  if (!ok) return false;
  const rec = S.records.find(x => x.id === id) || {};
  S.predForm = emptyPred();
  setTimeout(() => kDialog({
    title: 'Prediction saved', icon: 'ti-circle-check', width: 480,
    html: `<div class="cf-result-head"><div class="ico ok"><i class="ti ti-check"></i></div>
        <div><div class="t1">${esc(rec.vessel_name||'')}</div><div class="t2">${esc(rec.vessel_reference||'')} \u00b7 ${esc(f.qc)} \u00b7 ${+f.cmph} CMPH</div></div></div>
      <div class="rbox">
        ${row('Container work time', p.containerMin.toFixed(1) + ' min')}
        ${row('Gantry travel time', p.gantryMin.toFixed(1) + ' min')}
        ${row('Breakdown / buffer', p.bufferMin.toFixed(0) + ' min')}
        ${row('Total operation time', `${p.totalMin.toFixed(1)} min \u00b7 ${(p.totalMin/60).toFixed(2)} hrs`, 'font-weight:500')}
      </div>
      <div class="cf-big"><div><div style="font-size:12px;color:#6b6b67">Predicted last lift</div><div style="font-size:10px;color:#6b6b67;margin-top:2px">${toHM(now)} + total operation time</div></div>
        <span style="text-align:right"><span class="bigtime" style="color:#185FA5">${p.lastLiftStr}</span>${dayTag(p.lastLiftAt)}</span></div>
      <div class="cf-big"><div><div style="font-size:12px;color:#6b6b67">Recommended SRT</div><div style="font-size:10px;color:#6b6b67;margin-top:2px">Call pilot for this time</div></div>
        <span style="text-align:right"><span class="bigtime" style="color:#0F6E56">${p.srtStr}</span>${dayTag(p.srtAt)}</span></div>
      <div class="cf-note"><i class="ti ti-info-circle"></i><div>SRT is GOOD if actual last lift falls within 15 min before SRT (up to SRT itself).</div></div>`,
    actions: [{ text: 'Next: Actual Departure', icon: 'ti-arrow-right', theme: 'primary' }],
    onClose: () => { S.tab = 'actual'; S.selectedId = id; loadRecords().then(() => R()); }
  }), 50);
  return true;
}

// ── PHASE 3: ACTUAL DEPARTURE ──
function renderActual(tb) {
  const ready = S.records.filter(r => r.predicted_last_lift_time && !r.actual_last_lift_time);
  tb.innerHTML = `
  <div class="card">
    <div class="ctitle">Select vessel</div>
    ${!ready.length ? '<div class="empty">No records awaiting actual data. Complete a departure prediction first.</div>' : `
    <div class="fi">
      <label for="act-sel">Vessel <span style="font-size:10px;color:#6b6b67">(${ready.length} awaiting departure \u00b7 type to search)</span></label>
      <input id="act-sel" style="width:100%">
    </div>
    <div id="act-body"></div>`}
  </div>`;
  if (ready.length) vesselDDL('#act-sel', ready,
    x => 'Pred. LL ' + (x.predicted_last_lift_at ? fmtDT(new Date(x.predicted_last_lift_at)) : x.predicted_last_lift_time) + ' \u00b7 SRT ' + (x.suggested_srt_at ? fmtDT(new Date(x.suggested_srt_at)) : x.suggested_srt),
    v => { if ((v || null) !== S.selectedId) { S.selectedId = v || null; renderActBody(); } });
  renderActBody();
}

function renderActBody() {
  const body = document.getElementById('act-body');
  if (!body) return;
  const r = S.records.find(x => x.id === S.selectedId && x.predicted_last_lift_time && !x.actual_last_lift_time) || null;
  if (!r) { body.innerHTML = ''; return; }
  body.innerHTML = `
      <div class="rbox" style="margin-top:8px">
        ${row('Vessel', esc(r.vessel_name))}
        ${row('Reference', esc(r.vessel_reference))}
        ${row('Quick Start', r.quick_start_minutes + ' min ' + badge(r.quick_start_class))}
        ${row('Predicted last lift', `<span style="color:#185FA5">${showAt(r,'predicted_last_lift_at','predicted_last_lift_time')}</span>`)}
        ${row('Recommended SRT', `<span style="color:#0F6E56">${showAt(r,'suggested_srt_at','suggested_srt')}</span>`)}
        ${r.prediction_edited ? row('Prediction', `<span class="badge be"><i class="ti ti-pencil"></i>EDITED \u00d7${r.prediction_edit_count||1}</span>`) : ''}
      </div>
      <div class="sep"></div>
      <div class="ctitle">Actual departure times</div>
      <div class="time-group">
        ${fieldTime('d-ll','Actual last lift')}
        ${fieldTime('d-po','Pilot onboard')}
        ${fieldTime('d-srt','Actual SRT')}
      </div>
      <div class="g2" style="margin-bottom:9px">
        ${fieldTime('d-ll2','Last line')}
      </div>
      <div class="info-box" style="margin-bottom:9px">
        Quick Sail = Last Line \u2212 Last Lift &nbsp;\u00b7&nbsp; Target \u2264 17 min<br>
        Total Idle = Quick Start + Quick Sail &nbsp;\u00b7&nbsp; Target \u2264 37 min<br>
        <strong>\u26a0\ufe0f Last Line cannot be earlier than Last Lift.</strong><br>
        <span style="opacity:.8">Dates fill in automatically, including past midnight. Tap a date to change it.</span>
      </div>
      <div class="fi" style="margin-bottom:9px">
        <label for="act-rem">Remarks <span style="font-size:10px;color:#6b6b67">(mandatory)</span></label>
        <span class="${TA}"><textarea id="act-rem" class="k-input-inner" rows="2" placeholder="What happened \u2014 delays, breakdowns, early completion, etc."></textarea></span>
      </div>
      <button class="btn ${kBtn()}" onclick="calcActual('${r.id}')"><i class="ti ti-calculator"></i>Calculate actual departure</button>`;
  initDTGroup('dep'); dtSync('dep');
}

window.calcActual = function(id) {
  const ll = readDT('d-ll');
  const po = readDT('d-po');
  const srt = readDT('d-srt');
  const lastLine = readDT('d-ll2');
  const rem = document.getElementById('act-rem')?.value.trim();
  if (!ll||!po||!srt||!lastLine) { toast('All four time fields are mandatory.', 'warning'); return; }
  if (!rem) { toast('Remarks are mandatory.', 'warning'); document.getElementById('act-rem')?.focus(); return; }

  // ── POKA YOKE: Last Line cannot be earlier than Last Lift (date-aware) ──
  if (lastLine.dt < ll.dt) {
    kAlert('Poka Yoke check', 'Last Line (' + fmtDT(lastLine.dt) + ') cannot be earlier than Last Lift (' + fmtDT(ll.dt) + ').\nPlease check the times and dates.');
    return;
  }
  const rec = S.records.find(r=>r.id===id);
  if (!rec) return;

  kDialog({
    title: 'Confirm actual departure', icon: 'ti-clipboard-check', width: 500,
    html: `<div class="cf-lead">Please check the details below. Tap <b>Amend</b> to go back and correct anything.</div>
      <div class="cf-sec">Vessel</div>
      <div class="rbox">${row('Vessel', esc(rec.vessel_name))}${row('Reference', esc(rec.vessel_reference))}
        ${row('Predicted last lift', `<span style="color:#185FA5">${showAt(rec,'predicted_last_lift_at','predicted_last_lift_time')}</span>`)}
        ${row('Recommended SRT', `<span style="color:#0F6E56">${showAt(rec,'suggested_srt_at','suggested_srt')}</span>`)}</div>
      <div class="cf-sec">Actual departure times</div>
      <div class="rbox">${row('Actual last lift', fmtDT(ll.dt))}${row('Pilot onboard', fmtDT(po.dt))}${row('Actual SRT', fmtDT(srt.dt))}${row('Last line', fmtDT(lastLine.dt))}</div>
      <div class="cf-sec">Remarks</div>
      <div class="rbox" style="white-space:pre-wrap;font-size:13px">${escBr(rem)}</div>`,
    actions: [
      { text: 'Amend', icon: 'ti-pencil', theme: 'base' },
      { text: 'Calculate & save', icon: 'ti-device-floppy', theme: 'success', onClick: () => saveActual(id, { ll, po, srt, lastLine, rem }) }
    ]
  });
};

async function saveActual(id, { ll, po, srt, lastLine, rem }) {
  const rec = S.records.find(r=>r.id===id);
  const quickStart = +rec.quick_start_minutes || 0;
  // Legacy predictions without a stored date are placed nearest to the actual last lift
  const srtAt = recDT(rec, 'suggested_srt_at', 'suggested_srt', ll.dt);
  const predAt = recDT(rec, 'predicted_last_lift_at', 'predicted_last_lift_time', ll.dt);
  const ev = srtEval(srtAt, predAt, rec.suggested_srt, ll.dt);
  const quickSail = diffMin(ll.dt, lastLine.dt);
  const qsailClass = classifyQS(quickSail, 17);
  const totalIdle = quickStart + quickSail;
  const totalIdleClass = totalIdle <= 37 ? 'GOOD' : 'NOT QUALITY';

  const ok = await dbUpdate(id, {
    actual_last_lift_time: ll.hm, actual_pilot_onboard_time: po.hm, actual_srt_time: srt.hm,
    last_line_time: lastLine.hm,
    actual_last_lift_at: ll.dt.toISOString(), pilot_onboard_at: po.dt.toISOString(),
    actual_srt_at: srt.dt.toISOString(), last_line_at: lastLine.dt.toISOString(),
    ...ev,
    quick_sail_minutes: quickSail, quick_sail_class: qsailClass,
    total_idle_minutes: totalIdle, total_idle_class: totalIdleClass,
    departure_remarks: rem, departure_operator: S.operator
  });
  if (!ok) return false;
  const allGood = ev.srt_class === 'GOOD' && qsailClass === 'GOOD' && totalIdleClass === 'GOOD';
  setTimeout(() => kDialog({
    title: 'Actual departure saved', icon: 'ti-circle-check', width: 480,
    html: `<div class="cf-result-head"><div class="ico ${allGood?'ok':'bad'}"><i class="ti ti-${allGood?'check':'alert-triangle'}"></i></div>
        <div><div class="t1">${esc(rec.vessel_name)}</div><div class="t2">${esc(rec.vessel_reference)} \u00b7 record completed</div></div></div>
      <div class="rbox">
        ${row('SRT compliance window', `${ev.srt_window_start} \u2013 ${esc(ev.srt_window_end)}`)}
        ${row('SRT result', badge(ev.srt_class))}
        ${row('Quick Start', quickStart + ' min ' + badge(rec.quick_start_class))}
        ${row('Quick Sail (Last Line \u2212 Last Lift)', quickSail + ' min ' + badge(qsailClass), 'font-weight:500')}
        ${row('Total Idle (QS + QSail)', totalIdle + ' min ' + badge(totalIdleClass), 'font-weight:500')}
        ${row('LL deviation (pred vs actual)', `<span style="color:${Math.abs(ev.deviation_minutes)<=30?'#0F6E56':'#A32D2D'}">${ev.deviation_minutes>0?'+':''}${ev.deviation_minutes} min</span>`)}
      </div>`,
    actions: [{ text: 'View in Records', icon: 'ti-clipboard-list', theme: 'primary' }],
    onClose: () => { S.selectedId = null; S.tab = 'records'; S.expandRecId = id; loadRecords().then(() => R()); }
  }), 50);
  return true;
}

// ── RECORDS ──
function renderRecords(tb) {
  tb.innerHTML = `
  <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">
    <button class="btn-sm ${kBtn('base','md','outline')}" onclick="loadRecords()" style="margin-left:auto">
      <i class="ti ti-refresh"></i> Refresh
    </button>
  </div>
  <div class="card">
    ${S.loading ? '<div class="loading">Loading...</div>' : !S.records.length ? '<div class="empty">No records yet.</div>' :
    S.records.map(r => {
      const phase = !r.predicted_last_lift_time ? 'Arrival' : !r.actual_last_lift_time ? 'Prediction' : 'Completed';
      const phaseBadge = phase==='Completed'?'bg':phase==='Prediction'?'bp':'bb';
      return `
      <div class="rec-row" onclick="toggleRecExp('${r.id}')">
        <div style="min-width:0">
          <div class="rec-vessel">${esc(r.vessel_name)} <span style="font-size:11px;color:#6b6b67;font-weight:400">\u00b7 ${esc(r.vessel_reference)}</span></div>
          <div class="rec-meta">${new Date(r.created_at).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})} \u00b7 ${esc(r.operator_id)}</div>
        </div>
        <div class="rec-right">
          ${r.prediction_edited ? `<span class="badge be" title="Prediction edited ${r.prediction_edit_count||1}\u00d7"><i class="ti ti-pencil"></i>EDITED</span>` : ''}
          <span class="badge ${phaseBadge}">${phase}</span>
          <i class="ti ti-chevron-${S.expandRecId===r.id?'up':'down'}" style="font-size:14px;color:#6b6b67;flex-shrink:0"></i>
        </div>
      </div>
      ${S.expandRecId===r.id ? renderRecordDetail(r) : ''}`;
    }).join('')}
  </div>`;
}

const fmtStamp = iso => iso ? new Date(iso).toLocaleString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '';

function renderRecordDetail(r) {
  return `<div class="expand-panel">
  <div class="ep-title">Phase 1 \u2014 Arrival</div>
  <div class="rbox" style="margin-bottom:8px">
    ${row('Vessel reference', esc(r.vessel_reference))}
    ${row('First line', showAt(r,'first_line_at','first_line_time'))}
    ${row('Vessel secured (RTW)', showAt(r,'rtw_at','rtw_time'))}
    ${row('First lift', showAt(r,'first_lift_at','first_lift_time'))}
    ${row('Quick Start', r.quick_start_minutes + ' min ' + badge(r.quick_start_class), 'font-weight:500')}
    ${r.arrival_remarks?`<div class="rrow"><span>Remarks</span><span style="font-size:11px;color:#6b6b67;max-width:55%;text-align:right">${escBr(r.arrival_remarks)}</span></div>`:''}
  </div>
  ${r.predicted_last_lift_time?`
  <div class="ep-title" style="margin-top:8px;display:flex;align-items:center;gap:6px">Phase 2 \u2014 Departure Prediction
    ${r.prediction_edited ? `<span class="badge be"><i class="ti ti-pencil"></i>EDITED \u00d7${r.prediction_edit_count||1}</span>` : ''}</div>
  <div class="rbox" style="margin-bottom:8px">
    ${row('QC / CMPH', `${esc(r.qc_number)} \u00b7 ${r.cmph} CMPH`)}
    ${row('Total operation time', `${parseFloat(r.total_min).toFixed(1)} min`)}
    ${row('Predicted last lift', `<span style="color:#185FA5">${showAt(r,'predicted_last_lift_at','predicted_last_lift_time')}</span>`)}
    ${row('Recommended SRT', `<span style="color:#0F6E56">${showAt(r,'suggested_srt_at','suggested_srt')}</span>`)}
    ${r.prediction_operator ? row('Predicted by', esc(r.prediction_operator)) : ''}
    ${r.prediction_remarks?`<div class="rrow"><span>Remarks</span><span style="font-size:11px;color:#6b6b67;max-width:55%;text-align:right">${escBr(r.prediction_remarks)}</span></div>`:''}
  </div>
  ${r.prediction_edited ? `<div class="audit-box"><i class="ti ti-history"></i> Edited <b>${r.prediction_edit_count||1}\u00d7</b> \u00b7 last by <b>${esc(r.prediction_last_edited_by||'')}</b> on ${fmtStamp(r.prediction_last_edited_at)}${r.prediction_edit_reason ? `<br>Reason: ${escBr(r.prediction_edit_reason)}` : ''}</div>` : ''}
  <div class="ep-actions">
    <button class="${kBtn('primary','sm','outline')}" onclick="event.stopPropagation();openEditPrediction('${r.id}')"><i class="ti ti-pencil"></i>&nbsp;Edit prediction</button>
    ${r.prediction_edited ? `<button class="${kBtn('base','sm','outline')}" onclick="event.stopPropagation();openAuditTrail('${r.id}')"><i class="ti ti-history"></i>&nbsp;Audit trail</button>` : ''}
  </div>`:''}
  ${r.actual_last_lift_time?`
  <div class="ep-title" style="margin-top:12px">Phase 3 \u2014 Actual Departure</div>
  <div class="rbox">
    ${row('Actual last lift', showAt(r,'actual_last_lift_at','actual_last_lift_time'))}
    ${row('Pilot onboard', showAt(r,'pilot_onboard_at','actual_pilot_onboard_time'))}
    ${row('Actual SRT', showAt(r,'actual_srt_at','actual_srt_time'))}
    ${row('Last line', showAt(r,'last_line_at','last_line_time'))}
    ${row('SRT compliance window', `${esc(r.srt_window_start)} \u2013 ${esc(r.srt_window_end)}`)}
    ${row('SRT result', badge(r.srt_class))}
    ${row('Quick Sail (Last Line \u2212 Last Lift)', r.quick_sail_minutes + ' min ' + badge(r.quick_sail_class), 'font-weight:500')}
    ${row('Total Idle (QS + QSail)', r.total_idle_minutes + ' min ' + badge(r.total_idle_class), 'font-weight:500')}
    ${row('LL deviation (pred vs actual)', `<span style="color:${Math.abs(r.deviation_minutes)<=30?'#0F6E56':'#A32D2D'}">${r.deviation_minutes>0?'+':''}${r.deviation_minutes} min</span>`)}
    ${r.departure_remarks?`<div class="rrow"><span>Remarks</span><span style="font-size:11px;color:#6b6b67;max-width:55%;text-align:right">${escBr(r.departure_remarks)}</span></div>`:''}
  </div>`:''}
  </div>`;
}

// ── EDIT SAVED PREDICTION (with audit control) ──
// Every edit needs a reason. The database trigger in migration_prediction_audit.sql
// flags the record as edited, bumps the edit counter and writes old → new values
// to vsr_audit_log in the same transaction, so edits can't bypass the audit trail.
const AUDIT_LABELS = {
  qc_number:'QC number', qc_model:'QC model', qc_speed:'QC speed (m/min)', cmph:'CMPH',
  f1:'Normal container', f2:'Twin lift', f3:'Gearbox', f4:'Hatch cover', f5:'OOG', f6:'Open top',
  f7:'Gantry movement (bay)', f8:'Breakdown (min)',
  container_min:'Container work time (min)', gantry_min:'Gantry travel (min)', buffer_min:'Breakdown buffer (min)', total_min:'Total operation time (min)',
  predicted_last_lift_time:'Predicted last lift', predicted_last_lift_at:'Predicted last lift', suggested_srt:'Recommended SRT', suggested_srt_at:'Recommended SRT',
  prediction_remarks:'Prediction remarks',
  srt_window_start:'SRT window start', srt_window_end:'SRT window end', srt_class:'SRT result', deviation_minutes:'LL deviation (min)'
};
// Fields shown in the on-screen diff (duplicates like *_time and derived sub-totals are still logged by the DB)
const DIFF_SHOW = ['qc_number','cmph','f1','f2','f3','f4','f5','f6','f7','f8','total_min','predicted_last_lift_at','suggested_srt_at','prediction_remarks','srt_class','deviation_minutes'];

function fmtAuditVal(k, v) {
  if (v === null || v === undefined || v === '') return '\u2014';
  if (k.endsWith('_at')) return fmtDT(new Date(v));
  if (typeof v === 'number' || (/^-?\d+(\.\d+)?$/.test(String(v)) && !k.endsWith('_time') && k !== 'suggested_srt' && !k.startsWith('srt_window'))) {
    const n = +v; return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }
  return String(v);
}
const sameVal = (a, b) => {
  if ((a === null || a === undefined || a === '') && (b === null || b === undefined || b === '')) return true;
  if (!isNaN(+a) && !isNaN(+b) && a !== '' && b !== '' && typeof a !== 'boolean') return Math.abs(+a - +b) < 1e-6;
  const da = Date.parse(a), db = Date.parse(b);
  if (/T\d\d:/.test(String(a)) && /T\d\d:/.test(String(b)) && !isNaN(da) && !isNaN(db)) return da === db;
  return String(a) === String(b);
};

function predBase(r) {
  if (r.prediction_base_at) return new Date(r.prediction_base_at);
  const pred = recDT(r, 'predicted_last_lift_at', 'predicted_last_lift_time', new Date(r.created_at));
  return pred ? addMin(pred, -(+r.total_min || 0)) : new Date(r.created_at);
}

let EP = null;   // edit-prediction state

window.openEditPrediction = function(id) {
  const r = S.records.find(x => x.id === id);
  if (!r) return;
  const base = predBase(r);
  EP = { id, base, form: { qc: r.qc_number || '', qc_speed: r.qc_speed, cmph: r.cmph ?? '',
    f1:+r.f1||0, f2:+r.f2||0, f3:+r.f3||0, f4:+r.f4||0, f5:+r.f5||0, f6:+r.f6||0, f7:+r.f7||0, f8:+r.f8||0 } };
  const f = EP.form;
  const numIn = (id, unit) => `<span class="${IN}"><input id="e-${id}" class="k-input-inner" type="number" inputmode="decimal" value="${f[id]||''}" placeholder="0" min="0" oninput="epPreview()"><span class="k-input-suffix utag">${unit}</span></span>`;
  const html = `
    <div class="ew-base"><i class="ti ti-info-circle"></i> Recalculated from the original prediction time
      <b>${fmtDT(base)}</b>. Edits are marked on the record and logged in the audit trail with your ID and reason.</div>
    ${r.actual_last_lift_time ? `<div class="cf-note warn" style="margin:0 0 10px"><i class="ti ti-alert-triangle"></i><div>This record is completed. SRT result and LL deviation will be re-evaluated against the actual last lift (${showAt(r,'actual_last_lift_at','actual_last_lift_time')}).</div></div>` : ''}
    <div class="card"><div class="ctitle">Crane setup</div>
      <div class="g2">
        <div class="fi"><label for="e-qc">QC number (Last crane)</label><input id="e-qc" style="width:100%"></div>
        <div class="fi"><label for="e-cmph">CMPH</label><span class="${IN}"><input id="e-cmph" class="k-input-inner" type="number" inputmode="decimal" value="${f.cmph}" min="1" max="60" oninput="epPreview()"></span></div>
      </div></div>
    <div class="card"><div class="ctitle">Container workload</div>
      <div class="g2">
        ${WORKLOAD.map(([id,label,unit]) => `<div class="fi"><label for="e-${id}">${label}</label>${numIn(id, unit)}</div>`).join('')}
        <div class="fi"><label for="e-f7">Gantry movement</label>${numIn('f7','Bay')}</div>
        <div class="fi"><label for="e-f8">Breakdown</label>${numIn('f8','Min')}</div>
      </div></div>
    <div class="ctitle" style="margin-bottom:6px">Result preview</div>
    <div class="ew-preview" id="e-preview"></div>
    <div class="fi" style="margin-bottom:9px"><label for="e-rem">Prediction remarks</label>
      <span class="${TA}"><textarea id="e-rem" class="k-input-inner" rows="2">${esc(r.prediction_remarks||'')}</textarea></span></div>
    <div class="fi"><label for="e-reason">Reason for edit <span style="font-size:10px;color:#A32D2D">(mandatory \u2014 recorded in audit trail)</span></label>
      <span class="${TA}"><textarea id="e-reason" class="k-input-inner" rows="2" placeholder="e.g. Wrong QC selected, workload count corrected after stowage update"></textarea></span></div>
    <div class="ew-foot">
      <button class="${kBtn('base','md','solid')}" onclick="epClose()"><i class="ti ti-x"></i>&nbsp;Cancel</button>
      <button class="${kBtn('primary','md','solid')}" onclick="epReview()"><i class="ti ti-eye-check"></i>&nbsp;Review changes</button>
    </div>`;
  const $w = $('<div class="ew"></div>').html(html).appendTo('body');
  const win = $w.kendoWindow({
    title: 'Edit prediction \u2014 ' + r.vessel_name,
    modal: true, resizable: false, draggable: false, actions: ['Close'],
    width: Math.min(600, window.innerWidth - 16), maxHeight: Math.round(window.innerHeight * 0.92),
    deactivate: function() { kDestroy($w[0]); this.destroy(); $w.remove(); EP = null; }
  }).data('kendoWindow');
  EP.win = win;
  qcDDL('#e-qc', f.qc, v => { EP.form.qc = v; epPreview(); });
  win.center().open();
  epPreview();
};

window.epClose = function() { EP && EP.win && EP.win.close(); };

function epRead() {
  const f = EP.form;
  ['cmph','f1','f2','f3','f4','f5','f6','f7','f8'].forEach(id => {
    const el = document.getElementById('e-' + id);
    if (el) f[id] = id === 'cmph' ? el.value : (+el.value || 0);
  });
  return f;
}

window.epPreview = function() {
  if (!EP) return;
  const f = epRead();
  const r = S.records.find(x => x.id === EP.id);
  const box = document.getElementById('e-preview');
  if (!box) return;
  if (!f.qc || !(+f.cmph > 0)) { box.innerHTML = `<div class="metric" style="grid-column:1/-1;font-size:12px;color:#6b6b67">Select a QC and enter CMPH to preview.</div>`; return; }
  const p = computePrediction(f, EP.base);
  const oldLL = recDT(r, 'predicted_last_lift_at', 'predicted_last_lift_time', EP.base);
  const oldSRT = recDT(r, 'suggested_srt_at', 'suggested_srt', EP.base);
  const chgLL = !oldLL || toHM(oldLL) !== p.lastLiftStr, chgSRT = !oldSRT || toHM(oldSRT) !== p.srtStr;
  let srtLine = '';
  if (r.actual_last_lift_time) {
    const ll = recDT(r, 'actual_last_lift_at', 'actual_last_lift_time', p.lastLift);
    const ev = srtEval(p.srt, p.lastLift, p.srtStr, ll);
    srtLine = `<div class="metric" style="grid-column:1/-1;display:flex;justify-content:space-between;align-items:center"><span class="mlabel" style="margin:0">SRT result (re-evaluated)</span><span>${badge(r.srt_class)} \u2192 ${badge(ev.srt_class)}</span></div>`;
  }
  box.innerHTML = `
    <div class="metric"><div class="mlabel">Predicted last lift</div><div class="mval ${chgLL?'chg':''}" style="color:${chgLL?'':'#185FA5'}">${p.lastLiftStr}</div>
      <div class="msub">was ${oldLL ? toHM(oldLL) : '\u2014'} \u00b7 total ${p.totalMin.toFixed(1)} min</div></div>
    <div class="metric"><div class="mlabel">Recommended SRT</div><div class="mval ${chgSRT?'chg':''}" style="color:${chgSRT?'':'#0F6E56'}">${p.srtStr}</div>
      <div class="msub">was ${oldSRT ? toHM(oldSRT) : '\u2014'}</div></div>
    ${srtLine}`;
};

window.epReview = function() {
  if (!EP) return;
  const f = epRead();
  const r = S.records.find(x => x.id === EP.id);
  const reason = document.getElementById('e-reason')?.value.trim();
  const remarks = document.getElementById('e-rem')?.value.trim() || '';
  if (!f.qc) { toast('Please select a QC number.', 'warning'); return; }
  if (!(+f.cmph > 0)) { toast('Please enter CMPH.', 'warning'); return; }
  const p = computePrediction(f, EP.base);
  const upd = {
    qc_number: f.qc, qc_model: p.qc?.model || r.qc_model || '', qc_speed: p.qc?.speed || p.speed, cmph: +f.cmph,
    f1:+f.f1,f2:+f.f2,f3:+f.f3,f4:+f.f4,f5:+f.f5,f6:+f.f6,f7:+f.f7,f8:+f.f8,
    container_min: p.containerMin, gantry_min: p.gantryMin, buffer_min: p.bufferMin, total_min: p.totalMin,
    predicted_last_lift_time: p.lastLiftStr, suggested_srt: p.srtStr,
    predicted_last_lift_at: p.lastLiftAt, suggested_srt_at: p.srtAt,
    prediction_remarks: remarks
  };
  if (r.actual_last_lift_time) {
    const ll = recDT(r, 'actual_last_lift_at', 'actual_last_lift_time', p.lastLift);
    Object.assign(upd, srtEval(p.srt, p.lastLift, p.srtStr, ll));
  }
  // Compare against the stored record (legacy rows: compare inferred date-times)
  const cur = { ...r,
    predicted_last_lift_at: r.predicted_last_lift_at || recDT(r,'predicted_last_lift_at','predicted_last_lift_time',EP.base)?.toISOString(),
    suggested_srt_at: r.suggested_srt_at || recDT(r,'suggested_srt_at','suggested_srt',EP.base)?.toISOString() };
  // Recomputing from a derived base time can drift by a few ms — keep the stored value if under 1 s apart
  ['predicted_last_lift_at','suggested_srt_at'].forEach(k => {
    if (cur[k] && Math.abs(Date.parse(cur[k]) - Date.parse(upd[k])) < 1000) { upd[k] = r[k] ?? null; cur[k] = r[k] ?? null; }
  });
  const changed = Object.keys(upd).filter(k => !sameVal(cur[k], upd[k]));
  if (!changed.length) { toast('Nothing has changed \u2014 there is no edit to save.', 'info'); return; }
  if (!reason) { toast('Please enter the reason for this edit.', 'warning'); document.getElementById('e-reason')?.focus(); return; }

  const shown = DIFF_SHOW.filter(k => changed.includes(k));
  kDialog({
    title: 'Confirm prediction edit', icon: 'ti-pencil', width: 520,
    html: `<div class="cf-lead"><b>${esc(r.vessel_name)}</b> \u00b7 ${esc(r.vessel_reference)}<br>The following changes will be saved and logged in the audit trail.</div>
      <div class="rbox" style="padding:6px 8px"><table class="diff"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>
        ${shown.map(k => `<tr><td>${AUDIT_LABELS[k]}</td><td class="o">${esc(fmtAuditVal(k, cur[k]))}</td><td class="n">${esc(fmtAuditVal(k, upd[k]))}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="cf-sec">Audit entry</div>
      <div class="rbox">${row('Edited by', esc(S.operator))}${row('Edit #', String((+r.prediction_edit_count || 0) + 1))}${remRow('Reason', reason)}</div>`,
    actions: [
      { text: 'Amend', icon: 'ti-pencil', theme: 'base' },
      { text: 'Save edit', icon: 'ti-device-floppy', theme: 'success', onClick: () => saveEditPrediction(r.id, upd, reason) }
    ]
  });
};

async function saveEditPrediction(id, upd, reason) {
  const payload = { ...upd, edit_reason_input: reason, edit_by_input: S.operator };
  try {
    const { error } = await window.sb.from('vsr_records').update(payload).eq('id', id);
    if (error) throw error;
  } catch (e) {
    if (isMissingCol(e)) {
      kAlert('Audit control not set up', 'The audit columns/trigger are not in the database yet, so the edit was NOT saved.\nRun migration_prediction_audit.sql in Supabase \u2192 SQL Editor, then try again.');
    } else toast('Edit failed: ' + (e.message || e), 'error');
    return false;
  }
  toast('Prediction updated \u2014 edit logged in the audit trail.', 'success');
  setTimeout(() => { epClose(); S.expandRecId = id; loadRecords(); }, 50);
  return true;
}

window.openAuditTrail = async function(id) {
  const r = S.records.find(x => x.id === id);
  if (!r) return;
  let rows = [], err = null;
  try {
    const { data, error } = await window.sb.from('vsr_audit_log').select('*').eq('record_id', id).order('edited_at', { ascending: false });
    if (error) throw error;
    rows = data || [];
  } catch (e) { err = e; }
  const n = rows.length;
  const html = err
    ? `<div class="cf-note warn" style="margin:0"><i class="ti ti-alert-triangle"></i><div>Couldn't load the audit trail: ${esc(err.message || err)}<br>Run migration_prediction_audit.sql in Supabase if you haven't yet.</div></div>`
    : !n ? '<div class="empty">No edits logged for this record.</div>'
    : rows.map((a, i) => {
        const ch = a.changes || {};
        const keys = Object.keys(ch).filter(k => !k.endsWith('_time') || !ch[k.replace('_time','_at')]).filter(k => k !== 'suggested_srt' || !ch.suggested_srt_at);
        return `<div class="audit-entry">
          <div class="ah"><span><b>Edit #${n - i}</b> \u00b7 ${esc(a.edited_by || '')}</span><span style="color:#6b6b67">${fmtStamp(a.edited_at)}</span></div>
          <div class="ar">Reason: ${escBr(a.reason || '\u2014')}</div>
          <table class="diff"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>
          ${keys.map(k => `<tr><td>${esc(AUDIT_LABELS[k] || k)}</td><td class="o">${esc(fmtAuditVal(k, ch[k]?.old))}</td><td class="n">${esc(fmtAuditVal(k, ch[k]?.new))}</td></tr>`).join('')}
          </tbody></table></div>`;
      }).join('');
  kDialog({
    title: 'Audit trail \u2014 ' + r.vessel_name, icon: 'ti-history', width: 560,
    html: `<div class="cf-lead">${esc(r.vessel_reference)} \u00b7 original prediction by ${esc(r.prediction_operator || '\u2014')}. Entries are written by the database and can't be changed from the app.</div><div style="max-height:60vh;overflow:auto">${html}</div>`,
    actions: [{ text: 'Close', theme: 'primary' }]
  });
};

// ── DASHBOARD ──
function renderDashboard(tb) {
  const weekKeys = Array.from(new Set(S.records.map(r=>getWeekKey(new Date(r.created_at))))).sort().reverse();
  const monthKeys = Array.from(new Set(S.records.map(r=>getMonthKey(new Date(r.created_at))))).sort().reverse();

  let base = S.records;
  if (S.monthFilter!=='all') base = base.filter(r=>getMonthKey(new Date(r.created_at))===S.monthFilter);
  if (S.weekFilter!=='all') base = base.filter(r=>getWeekKey(new Date(r.created_at))===S.weekFilter);

  const done = base.filter(r=>r.actual_last_lift_time);

  const qsAll   = base.filter(r=>r.quick_start_minutes!=null);
  const qsGood  = qsAll.filter(r=>r.quick_start_class==='GOOD');
  const qsAvg   = qsAll.length ? Math.round(qsAll.reduce((s,r)=>s+r.quick_start_minutes,0)/qsAll.length) : 0;

  const qsailAll  = done.filter(r=>r.quick_sail_minutes!=null);
  const qsailGood = qsailAll.filter(r=>r.quick_sail_class==='GOOD');
  const qsailAvg  = qsailAll.length ? Math.round(qsailAll.reduce((s,r)=>s+r.quick_sail_minutes,0)/qsailAll.length) : 0;

  const srtAll  = done.filter(r=>r.srt_class);
  const srtGood = srtAll.filter(r=>r.srt_class==='GOOD');

  const tiAll   = done.filter(r=>r.total_idle_minutes!=null);
  const tiGood  = tiAll.filter(r=>r.total_idle_class==='GOOD');
  const tiAvg   = tiAll.length ? Math.round(tiAll.reduce((s,r)=>s+r.total_idle_minutes,0)/tiAll.length) : 0;

  const srtRate  = srtAll.length  ? Math.round(srtGood.length/srtAll.length*100)   : 0;
  const tiRate   = tiAll.length   ? Math.round(tiGood.length/tiAll.length*100)     : 0;
  const qsRate   = qsAll.length   ? Math.round(qsGood.length/qsAll.length*100)     : 0;
  const qsailRate= qsailAll.length? Math.round(qsailGood.length/qsailAll.length*100): 0;

  const col = r => r>=80?'#0F6E56':r>=60?'#854F0B':'#A32D2D';

  tb.innerHTML = `
  <div class="filter-row">
    <div class="fi"><label>Month</label>
      <select id="f-month" style="width:100%">
        <option value="all" ${S.monthFilter==='all'?'selected':''}>All months</option>
        ${monthKeys.map(mk=>`<option value="${mk}" ${S.monthFilter===mk?'selected':''}>${formatMonthLabel(mk)}</option>`).join('')}
      </select>
    </div>
    <div class="fi"><label>Workweek (Mon\u2013Sun)</label>
      <select id="f-week" style="width:100%">
        <option value="all" ${S.weekFilter==='all'?'selected':''}>All weeks</option>
        ${weekKeys.map(wk=>`<option value="${wk}" ${S.weekFilter===wk?'selected':''}>${formatWeekLabel(wk)}</option>`).join('')}
      </select>
    </div>
  </div>

  <!-- MAIN METRICS: SRT + Total Idle (larger) -->
  <div class="card">
    <div class="ctitle">Key metrics</div>
    <div class="donut-main">
      <div style="text-align:center">
        <div style="font-size:12px;font-weight:600;color:#6b6b67;margin-bottom:8px">SRT Compliance</div>
        <div style="position:relative;width:150px;height:150px;margin:0 auto">
          <canvas id="ch-srt" role="img" aria-label="SRT compliance: ${srtRate}%"></canvas>
          <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center">
            <div style="font-size:26px;font-weight:700;color:${col(srtRate)}">${srtRate}%</div>
            <div style="font-size:10px;color:#6b6b67">target 80%</div>
          </div>
        </div>
        <div style="font-size:11px;color:#6b6b67;margin-top:8px">${srtGood.length}/${srtAll.length} GOOD</div>
        <div style="font-size:10px;color:#6b6b67">SRT \u2212 15 min \u2264 Last Lift \u2264 SRT</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:12px;font-weight:500;color:#6b6b67;margin-bottom:8px">Total Idle Time</div>
        <div style="position:relative;width:150px;height:150px;margin:0 auto">
          <canvas id="ch-ti" role="img" aria-label="Total idle: ${tiRate}%"></canvas>
          <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center">
            <div style="font-size:26px;font-weight:700;color:${col(tiRate)}">${tiRate}%</div>
            <div style="font-size:10px;color:#6b6b67">target 80%</div>
          </div>
        </div>
        <div style="font-size:11px;color:#6b6b67;margin-top:8px">${tiGood.length}/${tiAll.length} GOOD &nbsp;\u00b7&nbsp; avg ${tiAvg} min</div>
        <div style="font-size:10px;color:#6b6b67">target \u2264 37 min total</div>
      </div>
    </div>
  </div>

  <!-- SECONDARY METRICS: Quick Start + Quick Sail (smaller) -->
  <div class="card">
    <div class="ctitle">Idle time breakdown</div>
    <div class="donut-secondary">
      <div style="text-align:center">
        <div style="font-size:11px;font-weight:600;color:#6b6b67;margin-bottom:6px">Quick Start</div>
        <div style="position:relative;width:110px;height:110px;margin:0 auto">
          <canvas id="ch-qs" role="img" aria-label="Quick Start: ${qsRate}%"></canvas>
          <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center">
            <div style="font-size:20px;font-weight:600;color:${col(qsRate)}">${qsRate}%</div>
          </div>
        </div>
        <div style="font-size:10px;color:#6b6b67;margin-top:6px">${qsGood.length}/${qsAll.length} GOOD &nbsp;\u00b7&nbsp; avg ${qsAvg} min</div>
        <div style="font-size:10px;color:#6b6b67">target \u2264 20 min</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:11px;font-weight:500;color:#6b6b67;margin-bottom:6px">Quick Sail</div>
        <div style="position:relative;width:110px;height:110px;margin:0 auto">
          <canvas id="ch-qsail" role="img" aria-label="Quick Sail: ${qsailRate}%"></canvas>
          <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center">
            <div style="font-size:20px;font-weight:600;color:${col(qsailRate)}">${qsailRate}%</div>
          </div>
        </div>
        <div style="font-size:10px;color:#6b6b67;margin-top:6px">${qsailGood.length}/${qsailAll.length} GOOD &nbsp;\u00b7&nbsp; avg ${qsailAvg} min</div>
        <div style="font-size:10px;color:#6b6b67">target \u2264 17 min</div>
      </div>
    </div>
  </div>

  ${done.length < 1 ? `<div class="card empty">Complete some records to see analytics.</div>` : `
  <div class="card">
    <div class="ctitle">Quick Start vs Quick Sail \u2014 last 10 vessels</div>
    <div style="position:relative;width:100%;height:220px"><canvas id="ch-bar" role="img" aria-label="Quick Start vs Quick Sail bar chart"></canvas></div>
  </div>
  <div class="card">
    <div class="ctitle">Recent completed records (last 30)</div>
    <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Date</th><th>Vessel</th><th>Q.Start</th><th>Q.Sail</th><th>Total Idle</th><th>SRT</th>
      </tr></thead>
      <tbody>${done.slice(0,30).map(r=>`<tr>
        <td style="font-family:monospace">${new Date(r.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short'})}</td>
        <td>${esc(r.vessel_name)}${r.prediction_edited ? ' <i class="ti ti-pencil" title="Prediction edited" style="color:#A0521A"></i>' : ''}</td>
        <td><span class="badge ${r.quick_start_class==='GOOD'?'bg':'bb'}">${r.quick_start_minutes}m</span></td>
        <td><span class="badge ${r.quick_sail_class==='GOOD'?'bg':'bb'}">${r.quick_sail_minutes}m</span></td>
        <td><span class="badge ${r.total_idle_class==='GOOD'?'bg':'bb'}">${r.total_idle_minutes}m</span></td>
        <td><span class="badge ${r.srt_class==='GOOD'?'bg':'bb'}">${r.srt_class}</span></td>
      </tr>`).join('')}</tbody>
    </table>
    </div>
  </div>
  <div class="card">
    <div class="ctitle">Download report</div>
    <div style="font-size:12px;color:#6b6b67;margin-bottom:10px">
      Export all completed records with every field as a CSV file. Filtered by month/week if active.
    </div>
    <button class="btn ${kBtn()}" onclick="downloadReport()">
      <i class="ti ti-download"></i>Download CSV report
    </button>
  </div>`}`;

  // ── KENDO FILTER DROPDOWNS ──
  if (window.kendo) {
    $('#f-month').kendoDropDownList({ height: 300, change: function() { const v = this.value(); afterClose(this, () => { S.monthFilter = v; renderTab(); }); } });
    $('#f-week').kendoDropDownList({ height: 300, change: function() { const v = this.value(); afterClose(this, () => { S.weekFilter = v; renderTab(); }); } });
  }

  // ── INIT CHARTS ──
  setTimeout(() => {
    const initDonut = (id, good, total, c1, c2) => {
      const el = document.getElementById(id);
      if (!el) return;
      Chart.getChart(el)?.destroy();
      new Chart(el, {
        type: 'doughnut',
        data: { datasets: [{ data: total===0?[1,0]:[good, Math.max(0,total-good)], backgroundColor: total===0?['#e5e5e5','#e5e5e5']:[c1||'#639922', c2||'#E24B4A'], borderWidth: 0 }] },
        options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false}, tooltip:{enabled:total>0} }, cutout:'68%' }
      });
    };

    initDonut('ch-srt',   srtGood.length,   srtAll.length);
    initDonut('ch-ti',    tiGood.length,    tiAll.length);
    initDonut('ch-qs',    qsGood.length,    qsAll.length);
    initDonut('ch-qsail', qsailGood.length, qsailAll.length);

    if (done.length >= 1) {
      const last10 = done.slice(0,10).reverse();
      const bar = document.getElementById('ch-bar');
      if (bar) {
        Chart.getChart(bar)?.destroy();
        new Chart(bar, {
          type: 'bar',
          data: {
            labels: last10.map(r=>r.vessel_name.slice(0,8)),
            datasets: [
              { label:'Quick Start', data:last10.map(r=>r.quick_start_minutes), backgroundColor:'#378ADD', borderRadius:3, borderWidth:0 },
              { label:'Quick Sail',  data:last10.map(r=>r.quick_sail_minutes),  backgroundColor:'#F58220', borderRadius:3, borderWidth:0 }
            ]
          },
          options: { responsive:true, maintainAspectRatio:false,
            plugins:{ legend:{ display:true, position:'top', labels:{ font:{size:10}, boxWidth:10 } } },
            scales:{
              y:{ grid:{color:'rgba(0,0,0,.06)'}, ticks:{font:{size:10}}, title:{display:true,text:'Minutes',font:{size:10}} },
              x:{ ticks:{autoSkip:false,maxRotation:35,font:{size:10}} }
            }
          }
        });
      }
    }
  }, 150);
}

// ── DOWNLOAD REPORT ──
window.downloadReport = function() {
  let base = S.records;
  if (S.monthFilter !== 'all') base = base.filter(r => getMonthKey(new Date(r.created_at)) === S.monthFilter);
  if (S.weekFilter !== 'all') base = base.filter(r => getWeekKey(new Date(r.created_at)) === S.weekFilter);
  const done = base.filter(r => r.actual_last_lift_time);
  if (!done.length) { toast('No completed records to export for the selected filter.', 'warning'); return; }

  const cols = [
    { key:'id',                       label:'ID' },
    { key:'created_at',               label:'Created At', fmt: v => v ? new Date(v).toLocaleString('en-GB') : '' },
    { key:'operator_id',              label:'Operator ID' },
    // Vessel
    { key:'vessel_name',              label:'Vessel Name' },
    { key:'vessel_reference',         label:'Vessel Reference' },
    // Phase 1 Arrival
    { key:'first_line_time',          label:'First Line Time' },
    { key:'rtw_time',                 label:'RTW Time' },
    { key:'first_lift_time',          label:'First Lift Time' },
    { key:'first_line_at',            label:'First Line Date-Time', fmt: csvDT },
    { key:'rtw_at',                   label:'RTW Date-Time',        fmt: csvDT },
    { key:'first_lift_at',            label:'First Lift Date-Time', fmt: csvDT },
    { key:'quick_start_minutes',      label:'Quick Start (min)' },
    { key:'quick_start_class',        label:'Quick Start Class' },
    { key:'arrival_remarks',          label:'Arrival Remarks' },
    // Phase 2 Prediction
    { key:'qc_number',                label:'QC Number' },
    { key:'qc_model',                 label:'QC Model' },
    { key:'qc_speed',                 label:'QC Speed (m/min)' },
    { key:'cmph',                     label:'CMPH' },
    { key:'f1',                       label:'Normal Container (Unit)' },
    { key:'f2',                       label:'Twin Lift (Unit)' },
    { key:'f3',                       label:'Gearbox (Unit)' },
    { key:'f4',                       label:'Hatch Cover (Unit)' },
    { key:'f5',                       label:'OOG (Unit)' },
    { key:'f6',                       label:'Open Top (Unit)' },
    { key:'f7',                       label:'Gantry Movement (Bay)' },
    { key:'f8',                       label:'Breakdown (Min)' },
    { key:'container_min',            label:'Container Work Time (min)' },
    { key:'gantry_min',               label:'Gantry Travel Time (min)' },
    { key:'buffer_min',               label:'Breakdown Buffer (min)' },
    { key:'total_min',                label:'Total Operation Time (min)' },
    { key:'predicted_last_lift_time', label:'Predicted Last Lift' },
    { key:'suggested_srt',            label:'Suggested SRT' },
    { key:'predicted_last_lift_at',   label:'Predicted Last Lift Date-Time', fmt: csvDT },
    { key:'suggested_srt_at',         label:'Suggested SRT Date-Time',       fmt: csvDT },
    { key:'prediction_remarks',       label:'Prediction Remarks' },
    { key:'prediction_operator',      label:'Prediction Operator' },
    { key:'prediction_base_at',       label:'Prediction Made At',            fmt: csvDT },
    { key:'prediction_edited',        label:'Prediction Edited',             fmt: v => v ? 'YES' : 'NO' },
    { key:'prediction_edit_count',    label:'Prediction Edit Count',         fmt: v => v || 0 },
    { key:'prediction_last_edited_by',label:'Prediction Last Edited By' },
    { key:'prediction_last_edited_at',label:'Prediction Last Edited At',     fmt: csvDT },
    { key:'prediction_edit_reason',   label:'Prediction Last Edit Reason' },
    // Phase 3 Actual
    { key:'actual_last_lift_time',    label:'Actual Last Lift' },
    { key:'actual_pilot_onboard_time',label:'Pilot Onboard' },
    { key:'actual_srt_time',          label:'Actual SRT' },
    { key:'last_line_time',           label:'Last Line Time' },
    { key:'actual_last_lift_at',      label:'Actual Last Lift Date-Time', fmt: csvDT },
    { key:'pilot_onboard_at',         label:'Pilot Onboard Date-Time',    fmt: csvDT },
    { key:'actual_srt_at',            label:'Actual SRT Date-Time',       fmt: csvDT },
    { key:'last_line_at',             label:'Last Line Date-Time',        fmt: csvDT },
    { key:'srt_window_start',         label:'SRT Window Start' },
    { key:'srt_window_end',           label:'SRT Window End' },
    { key:'srt_class',                label:'SRT Class' },
    { key:'deviation_minutes',        label:'LL Deviation (min)' },
    { key:'quick_sail_minutes',       label:'Quick Sail (min)' },
    { key:'quick_sail_class',         label:'Quick Sail Class' },
    { key:'total_idle_minutes',       label:'Total Idle (min)' },
    { key:'total_idle_class',         label:'Total Idle Class' },
    { key:'departure_remarks',        label:'Departure Remarks' },
    { key:'departure_operator',       label:'Departure Operator' },
  ];

  function csvDT(v) { if (!v) return ''; const d = new Date(v); return ymd(d) + ' ' + toHM(d); }

  const escape = v => {
    if (v === null || v === undefined) return '';
    const str = String(v);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  const header = cols.map(c => escape(c.label)).join(',');
  const rows = done.map(r =>
    cols.map(c => escape(c.fmt ? c.fmt(r[c.key]) : r[c.key])).join(',')
  );

  const csv = [header, ...rows].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const now = new Date();
  const dateStr = now.toISOString().slice(0,10);
  const filterStr = S.weekFilter !== 'all' ? '_' + S.weekFilter : S.monthFilter !== 'all' ? '_' + S.monthFilter : '';
  a.href = url;
  a.download = `VSR_Report${filterStr}_${dateStr}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// ── GLOBAL HANDLERS ──
window.doLogin = function() {
  const v = document.getElementById('op-inp')?.value.trim().toUpperCase();
  if (!v) { toast('Please enter your employee ID.', 'warning'); return; }
  S.operator = v; localStorage.setItem('ptp_op', v);
  loadRecords().then(()=>R());
};
window.doLogout = function() { S.operator=''; S.records=[]; localStorage.removeItem('ptp_op'); R(); };
window.setTab = function(t) {
  S.tab=t; S.predResult=null; R();
  if (['records','dashboard','prediction','actual'].includes(t)) loadRecords();
};
window.toggleRecExp = function(id) { S.expandRecId = S.expandRecId===id?null:id; renderTab(); };

// ── BOOT ──
(function boot() {
  if (window.supabase && window.sb) {
    loadQCDatabase().then(() => {
      if (S.operator) loadRecords().then(()=>R());
      else R();
    });
  } else {
    setTimeout(boot, 100);
  }
})();
