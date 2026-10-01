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
  arrForm: { vessel:'', reference:'', first_line:'', rtw:'', first_lift:'', remarks:'' },
  predForm: { qc:'', cmph:'', f1:0, f2:0, f3:0, f4:0, f5:0, f6:0, f7:0, f8:0 },
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
  } catch(e) { alert('Save failed: ' + e.message); return false; }
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
  } catch(e) { alert('Update failed: ' + e.message); return false; }
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

// ── TIME INPUT ──
function fieldTime(id, label) {
  return `<div class="fi">
    <div class="lrow"><label>${label}</label>
      <button type="button" class="dchip" id="${id}-dc" onclick="openDatePop('${id}',event)"></button></div>
    ${hhInput(id)}
  </div>`;
}

function hhInput(id) {
  return `<div class="iw" style="gap:0">
    <input type="number" id="${id}-h" placeholder="HH" min="0" max="23" maxlength="2" style="text-align:center;flex:1" oninput="hhAdv(this,'${id}-m');onTimeInput('${id}')">
    <span style="padding:0 4px;color:#6b6b67;font-size:16px;flex-shrink:0">:</span>
    <input type="number" id="${id}-m" placeholder="MM" min="0" max="59" maxlength="2" style="text-align:center;flex:1" oninput="onTimeInput('${id}')">
  </div>`;
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

// ── DONUT CHART BUILDER ──
function donutChart(id, good, total, label, target, color1, color2) {
  const notGood = total - good;
  const rate = total ? Math.round(good/total*100) : 0;
  const col = rate>=80?'#0F6E56':rate>=60?'#854F0B':'#A32D2D';
  return `<div style="text-align:center">
    <div style="font-size:11px;color:#6b6b67;margin-bottom:6px;font-weight:500">${label}</div>
    <div style="position:relative;width:120px;height:120px;margin:0 auto">
      <canvas id="${id}" role="img" aria-label="${label}: ${rate}% GOOD"></canvas>
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center">
        <div style="font-size:20px;font-weight:600;color:${col}">${rate}%</div>
      </div>
    </div>
    <div style="font-size:10px;color:#6b6b67;margin-top:6px">${good}/${total} GOOD</div>
    <div style="font-size:10px;color:#6b6b67">${target}</div>
  </div>`;
}

function initDonut(id, good, total) {
  const el = document.getElementById(id);
  if (!el) return;
  const notGood = Math.max(0, total - good);
  new Chart(el, {
    type: 'doughnut',
    data: { datasets: [{ data: total===0?[1,0]:[good, notGood], backgroundColor: total===0?['#e5e5e5','#e5e5e5']:['#639922','#E24B4A'], borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: total>0 } }, cutout: '68%' }
  });
}

// ── RENDER ──
function R() {
  const root = document.getElementById('root');
  if (!root) return;
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
      <label>Employee ID</label>
      <div class="iw"><input id="op-inp" placeholder="e.g. 0XXXX0" style="text-transform:uppercase" onkeydown="if(event.key==='Enter')doLogin()"></div>
    </div>
    <button class="btn" onclick="doLogin()">Enter system</button>
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
      <i class="ti ti-user" style="font-size:13px"></i>${S.operator}
      <button class="btn-sm" onclick="doLogout()" style="font-size:11px;padding:3px 8px">change</button>
    </span>
  </div>
  <div class="nav">
    <button class="${S.tab==='arrival'?'active':''}" onclick="setTab('arrival')"><i class="ti ti-anchor" style="font-size:14px"></i>Arrival</button>
    <button class="${S.tab==='prediction'?'active':''}" onclick="setTab('prediction')"><i class="ti ti-calculator" style="font-size:14px"></i>Dep. Prediction<span style="background:#f1f0eb;border-radius:4px;padding:1px 5px;font-size:10px;margin-left:4px">${pending.filter(r=>!r.predicted_last_lift_time).length}</span></button>
    <button class="${S.tab==='actual'?'active':''}" onclick="setTab('actual')"><i class="ti ti-clipboard-check" style="font-size:14px"></i>Actual Dep.</button>
    <button class="${S.tab==='records'?'active':''}" onclick="setTab('records')"><i class="ti ti-clipboard-list" style="font-size:14px"></i>Records<span style="background:#f1f0eb;border-radius:4px;padding:1px 5px;font-size:10px;margin-left:4px">${S.records.length}</span></button>
    <button class="${S.tab==='dashboard'?'active':''}" onclick="setTab('dashboard')"><i class="ti ti-chart-bar" style="font-size:14px"></i>Dashboard</button>
  </div>
  <div id="tab-body"></div>`;
  renderTab();
}

function renderTab() {
  const tb = document.getElementById('tab-body');
  if (!tb) return;
  if (S.tab==='arrival') renderArrival(tb);
  else if (S.tab==='prediction') renderPrediction(tb);
  else if (S.tab==='actual') renderActual(tb);
  else if (S.tab==='records') renderRecords(tb);
  else renderDashboard(tb);
}

// ── PHASE 1: ARRIVAL ──
function renderArrival(tb) {
  tb.innerHTML = `
  <div class="card">
    <div class="ctitle">Vessel information</div>
    <div class="g2" style="margin-bottom:9px">
      <div class="fi"><label>Vessel name</label>
        <div class="iw"><input id="a-vessel" value="${S.arrForm.vessel}" placeholder="e.g. EVER GIVEN" style="text-transform:uppercase" oninput="S.arrForm.vessel=this.value.toUpperCase()"></div>
      </div>
      <div class="fi"><label>Vessel reference</label>
        <div class="iw"><input id="a-ref" value="${S.arrForm.reference}" placeholder="e.g. VOY-2025-001" oninput="S.arrForm.reference=this.value"></div>
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
    <button class="btn" onclick="calcArrival()">Calculate arrival</button>
    <div id="arr-result" style="margin-top:9px"></div>
  </div>

  <div class="card" id="arr-save-card" style="display:none">
    <div class="fi" style="margin-bottom:9px">
      <label>Remarks <span style="font-size:10px;color:#6b6b67">(mandatory)</span></label>
      <textarea id="a-rem" rows="2" placeholder="Any notes about the arrival..."></textarea>
    </div>
    <button class="btn btn-green" onclick="saveArrival()">Save arrival record</button>
  </div>`;
  initDTGroup('arr');
  dtSync('arr');
}

window.calcArrival = function() {
  const vessel = document.getElementById('a-vessel')?.value.trim().toUpperCase();
  const ref = document.getElementById('a-ref')?.value.trim();
  const fl = readDT('a-fl');
  const rtw = readDT('a-rtw');
  const fli = readDT('a-fli');
  if (!vessel) { alert('Please enter vessel name.'); return; }
  if (!ref) { alert('Please enter vessel reference.'); return; }
  if (!fl||!rtw||!fli) { alert('Please enter all three arrival times.'); return; }

  // ── POKA YOKE: First Line ≤ RTW (date-aware). First Lift may precede RTW (negative Quick Start). ──
  if (rtw.dt < fl.dt) {
    alert('\u26a0\ufe0f Poka Yoke: Vessel Secured / RTW (' + fmtDT(rtw.dt) + ') cannot be earlier than First Line (' + fmtDT(fl.dt) + ').\nPlease check the times and dates.');
    return;
  }

  const qs = diffMin(rtw.dt, fli.dt);
  const qsClass = classifyQS(qs, 20);
  S.arrForm = { vessel, reference:ref, first_line:fl.hm, rtw:rtw.hm, first_lift:fli.hm,
    first_line_at:fl.dt.toISOString(), rtw_at:rtw.dt.toISOString(), first_lift_at:fli.dt.toISOString(),
    quick_start:qs, qs_class:qsClass };

  const res = document.getElementById('arr-result');
  res.innerHTML = `
  <div class="rbox">
    <div class="rrow"><span>First line</span><span class="rval">${fmtDT(fl.dt)}</span></div>
    <div class="rrow"><span>Vessel secured (RTW)</span><span class="rval">${fmtDT(rtw.dt)}</span></div>
    <div class="rrow"><span>First lift</span><span class="rval">${fmtDT(fli.dt)}</span></div>
    <div class="rrow" style="font-weight:500"><span>Quick Start (First Lift \u2212 RTW)</span>
      <span class="rval">${qs} min &nbsp;<span class="badge ${qsClass==='GOOD'?'bg':'bb'}">${qsClass}</span></span>
    </div>
    ${qs < 0 ? `<div class="early-note"><i class="ti ti-info-circle"></i>First Lift is ${-qs} min before RTW. Negative Quick Start will be recorded. Please explain in remarks.</div>` : ''}
  </div>`;
  document.getElementById('arr-save-card').style.display = 'block';
};

window.saveArrival = async function() {
  const rem = document.getElementById('a-rem')?.value.trim();
  if (!rem) { alert('Remarks are mandatory.'); return; }
  const f = S.arrForm;
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
    arrival_remarks: rem,
    operator_id: S.operator,
    created_at: new Date().toISOString()
  };
  const ok = await dbInsert(rec);
  if (!ok) return;
  S.arrForm = { vessel:'', reference:'', first_line:'', rtw:'', first_lift:'', remarks:'' };
  alert('Arrival saved for ' + rec.vessel_name + '\nQuick Start: ' + rec.quick_start_minutes + ' min (' + rec.quick_start_class + ')');
  S.tab = 'prediction';
  await loadRecords();
  R();
};

// ── PHASE 2: DEPARTURE PREDICTION ──
function renderPrediction(tb) {
  const pending = S.records.filter(r => !r.predicted_last_lift_time);
  const f = S.predForm;
  const qc = QC_DB.find(q => q.qc === f.qc);
  const qcSpeed = qc ? qc.speed : null;
  const cmph = parseFloat(f.cmph) || 0;
  const base = cmph > 0 ? 60 / cmph : 0;
  const mini = (id, factor) => { const qty = parseFloat(f[id])||0; return (cmph&&qty)?(qty*base*factor).toFixed(1)+' min':''; };

  tb.innerHTML = `
  <div class="card">
    <div class="ctitle">Select vessel</div>
    ${!pending.length ? '<div class="empty">No pending arrival records. Complete an arrival first.</div>' : `
    <div class="fi">
      <label>Vessel</label>
      <div class="iw"><select id="sel-record" onchange="S.selectedId=this.value;renderTab()">
        <option value="">— select vessel —</option>
        ${pending.map(r=>`<option value="${r.id}" ${S.selectedId===r.id?'selected':''}>${r.vessel_name} \u00b7 ${r.vessel_reference} \u00b7 ${new Date(r.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short'})}</option>`).join('')}
      </select></div>
    </div>
    ${S.selectedId ? (() => {
      const r = S.records.find(x=>x.id===S.selectedId);
      if (!r) return '';
      return `<div class="rbox" style="margin-top:8px">
        <div class="rrow"><span>Vessel</span><span class="rval">${r.vessel_name}</span></div>
        <div class="rrow"><span>Reference</span><span class="rval">${r.vessel_reference}</span></div>
        <div class="rrow"><span>Quick Start</span><span class="rval">${r.quick_start_minutes} min <span class="badge ${r.quick_start_class==='GOOD'?'bg':'bb'}">${r.quick_start_class}</span></span></div>
      </div>`;
    })() : ''}`}
  </div>

  ${S.selectedId ? `
  <div class="card">
    <div class="ctitle">Crane setup</div>
    <div class="g2" style="margin-bottom:9px">
      <div class="fi"><label>QC number (Last crane)</label>
        <div class="iw"><select id="p-qc" onchange="onPredQC(this.value)">
          <option value="">— select —</option>
          ${QC_DB.map(q=>`<option value="${q.qc}" ${f.qc===q.qc?'selected':''}>${q.qc}</option>`).join('')}
        </select></div>
        ${qc?`<div style="font-size:10px;color:#6b6b67;margin-top:2px">${qc.model} \u00b7 ${qc.speed} m/min</div>`:''}
      </div>
      <div class="fi"><label>CMPH</label>
        <div class="iw"><input id="p-cmph" type="number" value="${f.cmph}" placeholder="e.g. 28" min="1" max="60" oninput="updatePredHints()"></div>
        <div id="ph-cmph" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${cmph>0?(60/cmph).toFixed(2)+' min per move':''}</div>
      </div>
    </div>
    ${qcSpeed?`<div class="fi" style="margin-bottom:9px"><label>QC travel speed</label><div class="iw"><input value="${qcSpeed.toFixed(1)} m/min" readonly></div></div>`:''}
  </div>

  <div class="card">
    <div class="ctitle">Container workload</div>
    <div class="g2" style="margin-bottom:9px">
      <div class="fi"><label>Normal container</label>
        <div class="iw"><input id="p-f1" type="number" value="${f.f1||''}" placeholder="Quantity" min="0" oninput="updatePredHints()"><div class="utag">Unit</div></div>
        <div id="ph-f1" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${mini('f1',1.0)}</div>
      </div>
      <div class="fi"><label>Twin lift</label>
        <div class="iw"><input id="p-f2" type="number" value="${f.f2||''}" placeholder="Quantity" min="0" oninput="updatePredHints()"><div class="utag">Unit</div></div>
        <div id="ph-f2" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${mini('f2',0.5)}</div>
      </div>
      <div class="fi"><label>Gearbox</label>
        <div class="iw"><input id="p-f3" type="number" value="${f.f3||''}" placeholder="Quantity" min="0" oninput="updatePredHints()"><div class="utag">Unit</div></div>
        <div id="ph-f3" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${mini('f3',1.9157)}</div>
      </div>
      <div class="fi"><label>Hatch cover</label>
        <div class="iw"><input id="p-f4" type="number" value="${f.f4||''}" placeholder="Quantity" min="0" oninput="updatePredHints()"><div class="utag">Unit</div></div>
        <div id="ph-f4" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${mini('f4',1.5326)}</div>
      </div>
      <div class="fi"><label>OOG</label>
        <div class="iw"><input id="p-f5" type="number" value="${f.f5||''}" placeholder="Quantity" min="0" oninput="updatePredHints()"><div class="utag">Unit</div></div>
        <div id="ph-f5" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${mini('f5',3.0651)}</div>
      </div>
      <div class="fi"><label>Open top</label>
        <div class="iw"><input id="p-f6" type="number" value="${f.f6||''}" placeholder="Quantity" min="0" oninput="updatePredHints()"><div class="utag">Unit</div></div>
        <div id="ph-f6" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${mini('f6',1.9157)}</div>
      </div>
    </div>
    <div class="g2">
      <div class="fi"><label>Gantry movement</label>
        <div class="iw"><input id="p-f7" type="number" value="${f.f7||''}" placeholder="Quantity" min="0" oninput="updatePredHints()"><div class="utag">Bay</div></div>
        <div id="ph-f7" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${(qcSpeed&&f.f7>0)?((+f.f7*17.5/qcSpeed).toFixed(1)+' min travel'):''}</div>
      </div>
      <div class="fi"><label>Breakdown</label>
        <div class="iw"><input id="p-f8" type="number" value="${f.f8||''}" placeholder="Quantity" min="0"><div class="utag">Min</div></div>
        <div style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">Added to total time</div>
      </div>
    </div>
  </div>

  <div class="card">
    <button class="btn" onclick="doPredCalc()">Calculate prediction</button>
    ${S.predResult ? renderPredResult() : ''}
  </div>` : ''}`;
}

// Stored time with its date when available (records saved before dates show time only)
function showAt(r, atKey, hmKey) {
  if (r[atKey]) return fmtDT(new Date(r[atKey]));
  return r[hmKey] || '';
}

// Small date line under a big time, shown only when it isn't today
function dayTag(iso) {
  const d = new Date(iso);
  if (ymd(d) === ymd(new Date())) return '';
  return `<div class="daytag">${fmtDay(ymd(d))}</div>`;
}

function renderPredResult() {
  const r = S.predResult;
  return `<div class="sep"></div>
  <div class="ctitle">Prediction result</div>
  <div class="rbox">
    <div class="rrow"><span>Container work time</span><span class="rval">${r.containerMin.toFixed(1)} min</span></div>
    <div class="rrow"><span>Gantry travel time</span><span class="rval">${r.gantryMin.toFixed(1)} min</span></div>
    <div class="rrow"><span>Breakdown / buffer</span><span class="rval">${r.bufferMin.toFixed(0)} min</span></div>
    <div class="rrow" style="font-weight:500"><span>Total operation time</span><span class="rval">${r.totalMin.toFixed(1)} min \u00b7 ${(r.totalMin/60).toFixed(2)} hrs</span></div>
  </div>
  <div class="hrow">
    <div><div style="font-size:12px;color:#6b6b67">Predicted last lift</div><div style="font-size:10px;color:#6b6b67;margin-top:2px">Now + total operation time</div></div>
    <span style="text-align:right"><span class="bigtime" style="color:#185FA5">${r.lastLiftStr}</span>${dayTag(r.lastLiftAt)}</span>
  </div>
  <div class="hrow">
    <div><div style="font-size:12px;color:#6b6b67">Recommended SRT</div><div style="font-size:10px;color:#6b6b67;margin-top:2px">Rounded up to next 15 min mark</div></div>
    <span style="text-align:right"><span class="bigtime" style="color:#0F6E56">${r.srtStr}</span>${dayTag(r.srtAt)}</span>
  </div>
  <div class="info-box">SRT is GOOD if actual last lift falls within 15 min before SRT (up to SRT itself).</div>
  <div class="sep"></div>
  <div class="fi" style="margin-bottom:9px">
    <label>Remarks <span style="font-size:10px;opacity:.6">(optional)</span></label>
    <textarea id="pred-rem" rows="2" placeholder="Any notes or assumptions..."></textarea>
  </div>
  <button class="btn btn-green" onclick="savePrediction()">Save prediction</button>`;
}

window.onPredQC = function(v) { syncPredForm(); S.predForm.qc = v; renderTab(); };

window.doPredCalc = function() {
  syncPredForm();
  const f = S.predForm;
  if (!f.qc) { alert('Please select a QC number.'); return; }
  if (!f.cmph||+f.cmph<=0) { alert('Please enter CMPH.'); return; }
  const qc = QC_DB.find(q=>q.qc===f.qc);
  const res = calcAll(f, +f.cmph, qc?qc.speed:50);
  const now = new Date();
  const lastLift = addMin(now, res.totalMin);
  const srtTime = roundUpTo15(lastLift);
  S.predResult = { ...res, lastLiftStr: toHM(lastLift), srtStr: toHM(srtTime),
    lastLiftAt: lastLift.toISOString(), srtAt: srtTime.toISOString() };
  renderTab();
  setTimeout(()=>{ const el=document.querySelector('.hrow'); if(el) el.scrollIntoView({behavior:'smooth',block:'nearest'}); },100);
};

window.savePrediction = async function() {
  const rem = document.getElementById('pred-rem')?.value.trim()||'';
  const f = S.predForm; const r = S.predResult;
  const qc = QC_DB.find(q=>q.qc===f.qc);
  const ok = await dbUpdate(S.selectedId, {
    qc_number: f.qc, qc_model: qc?.model||'', qc_speed: qc?.speed||50, cmph: +f.cmph,
    f1:+f.f1,f2:+f.f2,f3:+f.f3,f4:+f.f4,f5:+f.f5,f6:+f.f6,f7:+f.f7,f8:+f.f8,
    container_min: r.containerMin, gantry_min: r.gantryMin, buffer_min: r.bufferMin, total_min: r.totalMin,
    predicted_last_lift_time: r.lastLiftStr, suggested_srt: r.srtStr,
    predicted_last_lift_at: r.lastLiftAt, suggested_srt_at: r.srtAt,
    prediction_remarks: rem, prediction_operator: S.operator
  });
  if (!ok) return;
  S.predResult = null;
  S.predForm = { qc:'', cmph:'', f1:0, f2:0, f3:0, f4:0, f5:0, f6:0, f7:0, f8:0 };
  alert('Prediction saved!\nCall pilot at: ' + r.srtStr);
  S.tab = 'actual';
  await loadRecords();
  R();
};

// ── PHASE 3: ACTUAL DEPARTURE ──
function renderActual(tb) {
  const ready = S.records.filter(r => r.predicted_last_lift_time && !r.actual_last_lift_time);
  tb.innerHTML = `
  <div class="card">
    <div class="ctitle">Select vessel</div>
    ${!ready.length ? '<div class="empty">No records awaiting actual data. Complete a departure prediction first.</div>' : `
    <div class="fi">
      <label>Vessel</label>
      <div class="iw"><select id="act-sel" onchange="S.selectedId=this.value;renderTab()">
        <option value="">— select vessel —</option>
        ${ready.map(r=>`<option value="${r.id}" ${S.selectedId===r.id?'selected':''}>${r.vessel_name} \u00b7 ${r.vessel_reference} \u00b7 SRT ${r.suggested_srt}</option>`).join('')}
      </select></div>
    </div>
    ${S.selectedId ? (() => {
      const r = S.records.find(x=>x.id===S.selectedId);
      if (!r) return '';
      return `
      <div class="rbox" style="margin-top:8px">
        <div class="rrow"><span>Vessel</span><span class="rval">${r.vessel_name}</span></div>
        <div class="rrow"><span>Reference</span><span class="rval">${r.vessel_reference}</span></div>
        <div class="rrow"><span>Quick Start</span><span class="rval">${r.quick_start_minutes} min <span class="badge ${r.quick_start_class==='GOOD'?'bg':'bb'}">${r.quick_start_class}</span></span></div>
        <div class="rrow"><span>Predicted last lift</span><span class="rval" style="color:#185FA5">${showAt(r,'predicted_last_lift_at','predicted_last_lift_time')}</span></div>
        <div class="rrow"><span>Recommended SRT</span><span class="rval" style="color:#0F6E56">${showAt(r,'suggested_srt_at','suggested_srt')}</span></div>
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
        <strong>⚠️ Last Line cannot be earlier than Last Lift.</strong><br>
        <span style="opacity:.8">Dates fill in automatically, including past midnight. Tap a date to change it.</span>
      </div>
      <div class="fi" style="margin-bottom:9px">
        <label>Remarks <span style="font-size:10px;color:#6b6b67">(mandatory)</span></label>
        <textarea id="act-rem" rows="2" placeholder="What happened \u2014 delays, breakdowns, early completion, etc."></textarea>
      </div>
      <button class="btn btn-green" onclick="saveActual('${r.id}', ${r.quick_start_minutes})">Save actual departure</button>`;
    })() : ''}`}
  </div>`;
  if (document.getElementById('d-ll-h')) { initDTGroup('dep'); dtSync('dep'); }
}

window.saveActual = async function(id, quickStart) {
  const ll = readDT('d-ll');
  const po = readDT('d-po');
  const srt = readDT('d-srt');
  const lastLine = readDT('d-ll2');
  const rem = document.getElementById('act-rem')?.value.trim();
  if (!ll||!po||!srt||!lastLine) { alert('All four time fields are mandatory.'); return; }
  if (!rem) { alert('Remarks are mandatory.'); return; }

  // ── POKA YOKE: Last Line cannot be earlier than Last Lift (date-aware) ──
  if (lastLine.dt < ll.dt) {
    alert('\u26a0\ufe0f Poka Yoke: Last Line (' + fmtDT(lastLine.dt) + ') cannot be earlier than Last Lift (' + fmtDT(ll.dt) + ').\nPlease check the times and dates.');
    return;
  }

  const rec = S.records.find(r=>r.id===id);
  // Legacy predictions without a stored date are placed nearest to the actual last lift
  const srtAt = recDT(rec, 'suggested_srt_at', 'suggested_srt', ll.dt);
  const predAt = recDT(rec, 'predicted_last_lift_at', 'predicted_last_lift_time', ll.dt);
  const srtWindowStart = toHM(addMin(srtAt, -15));
  const srtClass = (ll.dt >= addMin(srtAt, -15) && ll.dt <= srtAt) ? 'GOOD' : 'NOT QUALITY';
  const deviation = diffMin(predAt, ll.dt);
  const quickSail = diffMin(ll.dt, lastLine.dt);
  const qsailClass = classifyQS(quickSail, 17);
  const totalIdle = quickStart + quickSail;
  const totalIdleClass = totalIdle <= 37 ? 'GOOD' : 'NOT QUALITY';

  const ok = await dbUpdate(id, {
    actual_last_lift_time: ll.hm, actual_pilot_onboard_time: po.hm, actual_srt_time: srt.hm,
    last_line_time: lastLine.hm,
    actual_last_lift_at: ll.dt.toISOString(), pilot_onboard_at: po.dt.toISOString(),
    actual_srt_at: srt.dt.toISOString(), last_line_at: lastLine.dt.toISOString(),
    srt_window_start: srtWindowStart, srt_window_end: rec.suggested_srt,
    srt_class: srtClass, deviation_minutes: deviation,
    quick_sail_minutes: quickSail, quick_sail_class: qsailClass,
    total_idle_minutes: totalIdle, total_idle_class: totalIdleClass,
    departure_remarks: rem, departure_operator: S.operator
  });
  if (!ok) return;
  S.selectedId = null;
  alert(`Saved!\nSRT: ${srtClass}\nQuick Sail: ${quickSail} min (${qsailClass})\nTotal Idle: ${totalIdle} min (${totalIdleClass})`);
  S.tab = 'records';
  await loadRecords();
  R();
};

// ── RECORDS ──
function renderRecords(tb) {
  tb.innerHTML = `
  <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">
    <button class="btn-sm" onclick="loadRecords()" style="margin-left:auto">
      <i class="ti ti-refresh" style="font-size:13px;vertical-align:-1px"></i> Refresh
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
          <div class="rec-vessel">${r.vessel_name} <span style="font-size:11px;color:#6b6b67;font-weight:400">\u00b7 ${r.vessel_reference}</span></div>
          <div class="rec-meta">${new Date(r.created_at).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})} \u00b7 ${r.operator_id}</div>
        </div>
        <div class="rec-right">
          <span class="badge ${phaseBadge}">${phase}</span>
          <i class="ti ti-chevron-${S.expandRecId===r.id?'up':'down'}" style="font-size:14px;color:#6b6b67;flex-shrink:0"></i>
        </div>
      </div>
      ${S.expandRecId===r.id ? renderRecordDetail(r) : ''}`;
    }).join('')}
  </div>`;
}

function renderRecordDetail(r) {
  return `<div class="expand-panel">
  <div class="ep-title">Phase 1 \u2014 Arrival</div>
  <div class="rbox" style="margin-bottom:8px">
    <div class="rrow" style="font-size:13px"><span>Vessel reference</span><span class="rval">${r.vessel_reference}</span></div>
    <div class="rrow"><span>First line</span><span class="rval">${showAt(r,'first_line_at','first_line_time')}</span></div>
    <div class="rrow"><span>Vessel secured (RTW)</span><span class="rval">${showAt(r,'rtw_at','rtw_time')}</span></div>
    <div class="rrow"><span>First lift</span><span class="rval">${showAt(r,'first_lift_at','first_lift_time')}</span></div>
    <div class="rrow" style="font-weight:500"><span>Quick Start</span><span class="rval">${r.quick_start_minutes} min <span class="badge ${r.quick_start_class==='GOOD'?'bg':'bb'}">${r.quick_start_class}</span></span></div>
    ${r.arrival_remarks?`<div class="rrow"><span>Remarks</span><span style="font-size:11px;color:#6b6b67;max-width:55%;text-align:right">${r.arrival_remarks}</span></div>`:''}
  </div>
  ${r.predicted_last_lift_time?`
  <div class="ep-title" style="margin-top:8px">Phase 2 \u2014 Departure Prediction</div>
  <div class="rbox" style="margin-bottom:8px">
    <div class="rrow"><span>QC / CMPH</span><span class="rval">${r.qc_number} \u00b7 ${r.cmph} CMPH</span></div>
    <div class="rrow"><span>Total operation time</span><span class="rval">${parseFloat(r.total_min).toFixed(1)} min</span></div>
    <div class="rrow"><span>Predicted last lift</span><span class="rval" style="color:#185FA5">${showAt(r,'predicted_last_lift_at','predicted_last_lift_time')}</span></div>
    <div class="rrow"><span>Recommended SRT</span><span class="rval" style="color:#0F6E56">${showAt(r,'suggested_srt_at','suggested_srt')}</span></div>
    ${r.prediction_remarks?`<div class="rrow"><span>Remarks</span><span style="font-size:11px;color:#6b6b67;max-width:55%;text-align:right">${r.prediction_remarks}</span></div>`:''}
  </div>`:''}
  ${r.actual_last_lift_time?`
  <div class="ep-title" style="margin-top:8px">Phase 3 \u2014 Actual Departure</div>
  <div class="rbox">
    <div class="rrow"><span>Actual last lift</span><span class="rval">${showAt(r,'actual_last_lift_at','actual_last_lift_time')}</span></div>
    <div class="rrow"><span>Pilot onboard</span><span class="rval">${showAt(r,'pilot_onboard_at','actual_pilot_onboard_time')}</span></div>
    <div class="rrow"><span>Actual SRT</span><span class="rval">${showAt(r,'actual_srt_at','actual_srt_time')}</span></div>
    <div class="rrow"><span>Last line</span><span class="rval">${showAt(r,'last_line_at','last_line_time')}</span></div>
    <div class="rrow"><span>SRT compliance window</span><span class="rval">${r.srt_window_start} \u2013 ${r.srt_window_end}</span></div>
    <div class="rrow"><span>SRT result</span><span class="rval"><span class="badge ${r.srt_class==='GOOD'?'bg':'bb'}">${r.srt_class}</span></span></div>
    <div class="rrow" style="font-weight:500"><span>Quick Sail (Last Line \u2212 Last Lift)</span><span class="rval">${r.quick_sail_minutes} min <span class="badge ${r.quick_sail_class==='GOOD'?'bg':'bb'}">${r.quick_sail_class}</span></span></div>
    <div class="rrow" style="font-weight:500"><span>Total Idle (QS + QSail)</span><span class="rval">${r.total_idle_minutes} min <span class="badge ${r.total_idle_class==='GOOD'?'bg':'bb'}">${r.total_idle_class}</span></span></div>
    <div class="rrow"><span>LL deviation (pred vs actual)</span><span class="rval" style="color:${Math.abs(r.deviation_minutes)<=30?'#0F6E56':'#A32D2D'}">${r.deviation_minutes>0?'+':''}${r.deviation_minutes} min</span></div>
    ${r.departure_remarks?`<div class="rrow"><span>Remarks</span><span style="font-size:11px;color:#6b6b67;max-width:55%;text-align:right">${r.departure_remarks}</span></div>`:''}
  </div>`:''}
  </div>`;
}

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
      <div class="iw"><select onchange="S.monthFilter=this.value;renderTab()">
        <option value="all" ${S.monthFilter==='all'?'selected':''}>All months</option>
        ${monthKeys.map(mk=>`<option value="${mk}" ${S.monthFilter===mk?'selected':''}>${formatMonthLabel(mk)}</option>`).join('')}
      </select></div>
    </div>
    <div class="fi"><label>Workweek (Mon\u2013Sun)</label>
      <div class="iw"><select onchange="S.weekFilter=this.value;renderTab()">
        <option value="all" ${S.weekFilter==='all'?'selected':''}>All weeks</option>
        ${weekKeys.map(wk=>`<option value="${wk}" ${S.weekFilter===wk?'selected':''}>${formatWeekLabel(wk)}</option>`).join('')}
      </select></div>
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
        <td>${r.vessel_name}</td>
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
    <button class="btn" onclick="downloadReport()" style="background:#185FA5">
      <i class="ti ti-download" style="font-size:15px;vertical-align:-2px;margin-right:6px"></i>
      Download CSV report
    </button>
  </div>`}`;

  // ── INIT CHARTS ──
  setTimeout(() => {
    const initDonut = (id, good, total, c1, c2) => {
      const el = document.getElementById(id);
      if (!el) return;
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
  if (!done.length) { alert('No completed records to export for the selected filter.'); return; }

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
  if (!v) { alert('Please enter your employee ID.'); return; }
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
