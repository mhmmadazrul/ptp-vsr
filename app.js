let QC_DB = [];

async function loadQCDatabase() {
  try {
    const { data, error } = await window.sb.from('qc_database').select('*').order('qc_number');
    if (error) throw error;
    QC_DB = (data || []).map(r => ({
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
  tab: 'predict', recTab: 'pending',
  operator: localStorage.getItem('ptp_op') || '',
  records: [], loading: false,
  form: { vessel:'', qc:'', cmph:'', f1:0, f2:0, f3:0, f4:0, f5:0, f6:0, f7:0, f8:0 },
  result: null, expandId: null,
  weekFilter: 'all', monthFilter: 'all'
};

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const addMin = (d, m) => new Date(d.getTime() + m * 60000);
const toHM = d => d.toTimeString().slice(0,5);
const parseT = s => { const [h,m] = s.split(':'); const d = new Date(); d.setHours(+h,+m,0,0); return d; };

// ISO workweek helpers (Monday-start)
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
  return weekKey + '  (' + fmt(monday) + ' \u2013 ' + fmt(sunday) + ')';
}
function getMonthKey(date) {
  return date.getFullYear() + '-M' + String(date.getMonth() + 1).padStart(2,'0');
}
function formatMonthLabel(monthKey) {
  const [yr, mo] = monthKey.split('-M').map(Number);
  const d = new Date(yr, mo - 1, 1);
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

async function loadRecords() {
  S.loading = true; renderTab();
  try {
    const { data, error } = await window.sb.from('pilot_booking_records').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    S.records = data || [];
  } catch(e) {
    console.error('Load error:', e);
    S.records = [];
  }
  S.loading = false;
  renderTab();
}

async function dbInsert(rec) {
  try {
    const { error } = await window.sb.from('pilot_booking_records').insert([rec]);
    if (error) throw error;
    return true;
  } catch(e) {
    alert('Save failed: ' + e.message);
    return false;
  }
}

async function dbUpdate(id, updates) {
  try {
    const { error } = await window.sb.from('pilot_booking_records').update(updates).eq('id', id);
    if (error) throw error;
    return true;
  } catch(e) {
    alert('Update failed: ' + e.message);
    return false;
  }
}

function calcAll(f, cmph, qcSpeed) {
  const base = 60 / cmph;
  let containerMin = 0;
  ['f1','f2','f3','f4','f5','f6'].forEach(id => { containerMin += +(f[id]||0) * base * F[id]; });
  const gantryMin = +(f.f7||0) * 17.5 / qcSpeed;
  const bufferMin = +(f.f8||0);
  return { containerMin, gantryMin, bufferMin, totalMin: containerMin + gantryMin + bufferMin };
}

// QUALITY RULE:
// GOOD: SRT - 15 min <= actual_last_lift <= SRT
// NOT QUALITY: actual_last_lift more than 15 min before SRT, or after SRT
function classifyQuality(srtTime, actualLastLift) {
  const srt = parseT(srtTime);
  const actual = parseT(actualLastLift);
  const windowStart = addMin(srt, -15);
  return (actual >= windowStart && actual <= srt) ? 'GOOD' : 'NOT QUALITY';
}

function syncForm() {
  const ids = ['vessel','cmph','f1','f2','f3','f4','f5','f6','f7','f8'];
  ids.forEach(id => {
    const el = document.getElementById('f-' + id);
    if (!el) return;
    const val = el.value;
    if (id === 'vessel') S.form.vessel = val.toUpperCase();
    else if (id === 'cmph') S.form.cmph = val;
    else S.form[id] = +val || 0;
  });
}

function updateHints() {
  syncForm();
  const cmph = parseFloat(S.form.cmph) || 0;
  const qc = QC_DB.find(q => q.qc === S.form.qc);
  const qcSpeed = qc ? qc.speed : 50;
  const base = cmph > 0 ? 60 / cmph : 0;
  const fieldMap = { f1:1.0, f2:0.5, f3:1.9157, f4:1.5326, f5:3.0651, f6:1.9157 };
  Object.entries(fieldMap).forEach(([id, factor]) => {
    const hint = document.getElementById('hint-' + id);
    if (!hint) return;
    const qty = parseFloat(S.form[id]) || 0;
    hint.textContent = (cmph && qty) ? (qty * base * factor).toFixed(1) + ' min' : '';
  });
  const hg = document.getElementById('hint-f7');
  if (hg) {
    const bays = parseFloat(S.form.f7) || 0;
    hg.textContent = (qcSpeed && bays) ? (bays * 17.5 / qcSpeed).toFixed(1) + ' min travel' : '';
  }
  const hc = document.getElementById('hint-cmph');
  if (hc) hc.textContent = cmph > 0 ? (60/cmph).toFixed(2) + ' min per move' : '';
}

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
    <i class="ti ti-anchor" style="font-size:36px;color:#185FA5"></i>
    <div style="font-weight:600;font-size:16px;margin:12px 0 4px">PTP Pilot Booking System</div>
    <div style="font-size:13px;color:#6b6b67;margin-bottom:20px">Port of Tanjung Pelepas</div>
    <div class="fi" style="margin-bottom:14px;text-align:left">
      <label>Employee ID</label>
      <div class="iw"><input id="op-inp" placeholder="e.g. 0XXXX0" style="text-transform:uppercase" onkeydown="if(event.key==='Enter')doLogin()"></div>
    </div>
    <button class="btn" onclick="doLogin()">Enter system</button>
  </div></div>`;
}

function renderApp(root) {
  root.innerHTML = `
  <div class="topbar">
    <i class="ti ti-anchor" style="font-size:20px;color:#185FA5;flex-shrink:0"></i>
    <span class="topbar-title">PTP Pilot Booking</span>
    <span class="topbar-sub">Port of Tanjung Pelepas</span>
    <span style="margin-left:auto;font-size:11px;color:#6b6b67;display:flex;align-items:center;gap:6px;flex-shrink:0">
      <i class="ti ti-user" style="font-size:13px"></i>${S.operator}
      <button class="btn-sm" onclick="doLogout()" style="font-size:11px;padding:3px 8px">change</button>
    </span>
  </div>
  <div class="nav">
    <button class="${S.tab==='predict'?'active':''}" onclick="setTab('predict')"><i class="ti ti-calculator" style="font-size:14px"></i>Prediction</button>
    <button class="${S.tab==='records'?'active':''}" onclick="setTab('records')"><i class="ti ti-clipboard-list" style="font-size:14px"></i>Records<span style="background:#f1f0eb;border-radius:4px;padding:1px 5px;font-size:10px;margin-left:4px">${S.records.length}</span></button>
    <button class="${S.tab==='dashboard'?'active':''}" onclick="setTab('dashboard')"><i class="ti ti-chart-bar" style="font-size:14px"></i>Dashboard</button>
  </div>
  <div id="tab-body"></div>`;
  renderTab();
}

function renderTab() {
  const tb = document.getElementById('tab-body');
  if (!tb) return;
  if (S.tab === 'predict') renderPredict(tb);
  else if (S.tab === 'records') renderRecords(tb);
  else renderDashboard(tb);
}

function renderPredict(tb) {
  const f = S.form;
  const qc = QC_DB.find(q => q.qc === f.qc);
  const qcSpeed = qc ? qc.speed : null;
  const cmph = parseFloat(f.cmph) || 0;
  const base = cmph > 0 ? 60 / cmph : 0;
  const mini = (id, factor) => { const qty = parseFloat(f[id]) || 0; return (cmph && qty) ? (qty * base * factor).toFixed(1) + ' min' : ''; };

  tb.innerHTML = `
  <div class="card">
    <div class="ctitle">Vessel & crane</div>
    <div class="g2" style="margin-bottom:9px">
      <div class="fi">
        <label>Vessel name</label>
        <div class="iw"><input id="f-vessel" value="${f.vessel}" placeholder="e.g. EVER GIVEN" style="text-transform:uppercase"></div>
      </div>
      <div class="fi">
        <label>QC number</label>
        <div class="iw"><select id="f-qc" onchange="onQC(this.value)">
          <option value="">— select —</option>
          ${QC_DB.map(q => `<option value="${q.qc}" ${f.qc===q.qc?'selected':''}>${q.qc}</option>`).join('')}
        </select></div>
        ${qc ? `<div style="font-size:10px;color:#6b6b67;margin-top:2px">${qc.model} \u00b7 ${qc.speed} m/min</div>` : ''}
      </div>
    </div>
    <div class="g2">
      <div class="fi">
        <label>CMPH \u2014 crane moves per hour</label>
        <div class="iw"><input id="f-cmph" type="number" value="${f.cmph}" placeholder="e.g. 28" min="1" max="60" oninput="updateHints()"></div>
        <div id="hint-cmph" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${cmph > 0 ? (60/cmph).toFixed(2)+' min per move' : ''}</div>
      </div>
      <div class="fi">
        <label>QC travel speed (m/min)</label>
        <div class="iw"><input value="${qcSpeed ? qcSpeed.toFixed(1)+' m/min' : '\u2014'}" readonly></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="ctitle">Container workload</div>
    <div class="g2" style="margin-bottom:9px">
      <div class="fi"><label>Normal container</label>
        <div class="iw"><input id="f-f1" type="number" value="${f.f1||''}" placeholder="Quantity" min="0" oninput="updateHints()"><div class="utag">Unit</div></div>
        <div id="hint-f1" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${mini('f1',1.0)}</div>
      </div>
      <div class="fi"><label>Twin container</label>
        <div class="iw"><input id="f-f2" type="number" value="${f.f2||''}" placeholder="Quantity" min="0" oninput="updateHints()"><div class="utag">Unit</div></div>
        <div id="hint-f2" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${mini('f2',0.5)}</div>
      </div>
      <div class="fi"><label>Gearbox</label>
        <div class="iw"><input id="f-f3" type="number" value="${f.f3||''}" placeholder="Quantity" min="0" oninput="updateHints()"><div class="utag">Unit</div></div>
        <div id="hint-f3" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${mini('f3',1.9157)}</div>
      </div>
      <div class="fi"><label>Hatch cover</label>
        <div class="iw"><input id="f-f4" type="number" value="${f.f4||''}" placeholder="Quantity" min="0" oninput="updateHints()"><div class="utag">Unit</div></div>
        <div id="hint-f4" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${mini('f4',1.5326)}</div>
      </div>
      <div class="fi"><label>OOG</label>
        <div class="iw"><input id="f-f5" type="number" value="${f.f5||''}" placeholder="Quantity" min="0" oninput="updateHints()"><div class="utag">Unit</div></div>
        <div id="hint-f5" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${mini('f5',3.0651)}</div>
      </div>
      <div class="fi"><label>Open top</label>
        <div class="iw"><input id="f-f6" type="number" value="${f.f6||''}" placeholder="Quantity" min="0" oninput="updateHints()"><div class="utag">Unit</div></div>
        <div id="hint-f6" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${mini('f6',1.9157)}</div>
      </div>
    </div>
    <div class="g2">
      <div class="fi"><label>Gantry movement</label>
        <div class="iw"><input id="f-f7" type="number" value="${f.f7||''}" placeholder="Quantity" min="0" oninput="updateHints()"><div class="utag">Bay</div></div>
        <div id="hint-f7" style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">${(qcSpeed&&f.f7>0)?((+f.f7*17.5/qcSpeed).toFixed(1)+' min travel'):''}</div>
      </div>
      <div class="fi"><label>Breakdown</label>
        <div class="iw"><input id="f-f8" type="number" value="${f.f8||''}" placeholder="Quantity" min="0"><div class="utag">Min</div></div>
        <div style="font-size:10px;color:#6b6b67;margin-top:2px;min-height:14px">Added to total operation time</div>
      </div>
    </div>
  </div>

  <div class="card">
    <button class="btn" onclick="doCalc()">Calculate prediction</button>
    ${S.result ? renderResult() : ''}
  </div>`;
}

function renderResult() {
  const r = S.result;
  return `<div class="sep"></div>
  <div class="ctitle">Prediction result</div>
  <div class="rbox">
    <div class="rrow"><span>Container work time</span><span class="rval">${r.containerMin.toFixed(1)} min</span></div>
    <div class="rrow"><span>Gantry travel time</span><span class="rval">${r.gantryMin.toFixed(1)} min</span></div>
    <div class="rrow"><span>Breakdown / buffer</span><span class="rval">${r.bufferMin.toFixed(0)} min</span></div>
    <div class="rrow" style="font-weight:500"><span>Total operation time</span><span class="rval">${r.totalMin.toFixed(1)} min \u00b7 ${(r.totalMin/60).toFixed(2)} hrs</span></div>
  </div>
  <div class="hrow">
    <div><div style="font-size:12px;color:#6b6b67">Predicted last lift</div><div style="font-size:10px;color:#6b6b67;margin-top:2px">Current time + total operation time</div></div>
    <span class="bigtime" style="color:#185FA5">${r.lastLiftStr}</span>
  </div>
  <div class="hrow">
    <div><div style="font-size:12px;color:#6b6b67">Recommended SRT</div></div>
    <span class="bigtime" style="color:#0F6E56">${r.srtStr}</span>
  </div>
  <div class="info-box">Quality SRT: actual last lift must be within 15 min before SRT (up to SRT itself). Outside this window = NOT QUALITY.</div>
  <div class="sep"></div>
  <div class="fi" style="margin-bottom:9px">
    <label>Remarks <span style="font-size:10px;opacity:.6">(optional)</span></label>
    <textarea id="p1-rem" rows="2" placeholder="Any notes or assumptions about this prediction..."></textarea>
  </div>
  <button class="btn btn-green" onclick="savePhase1()">Save prediction record</button>`;
}

function renderRecords(tb) {
  const pending = S.records.filter(r => !r.actual_last_lift_time);
  const completed = S.records.filter(r => r.actual_last_lift_time);
  const list = S.recTab === 'done' ? completed : pending;
  tb.innerHTML = `
  <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">
    <button class="btn-sm" onclick="S.recTab='pending';renderTab()" style="${S.recTab!=='done'?'border-color:#0F6E56;color:#0F6E56':''}">
      Pending<span style="background:#f1f0eb;border-radius:4px;padding:1px 5px;font-size:10px;margin-left:4px">${pending.length}</span>
    </button>
    <button class="btn-sm" onclick="S.recTab='done';renderTab()" style="${S.recTab==='done'?'border-color:#0F6E56;color:#0F6E56':''}">
      Completed<span style="background:#f1f0eb;border-radius:4px;padding:1px 5px;font-size:10px;margin-left:4px">${completed.length}</span>
    </button>
    <button class="btn-sm" onclick="loadRecords()" style="margin-left:auto">
      <i class="ti ti-refresh" style="font-size:13px;vertical-align:-1px"></i> Refresh
    </button>
  </div>
  <div class="card">
    ${S.loading ? '<div class="loading">Loading records...</div>' :
      !list.length ? '<div class="empty">No records here yet.</div>' :
      list.map(r => `
      <div class="rec-row" onclick="toggleExp('${r.id}')">
        <div style="min-width:0">
          <div class="rec-vessel">${r.vessel_name}</div>
          <div class="rec-meta">${r.qc_number} \u00b7 CMPH ${r.cmph} \u00b7 ${new Date(r.created_at).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})} \u00b7 ${r.operator_id}</div>
        </div>
        <div class="rec-right">
          <span class="badge ${r.booking_quality==='GOOD'?'bg':r.booking_quality==='NOT QUALITY'?'bb':'bp'}">${r.booking_quality||'Pending'}</span>
          <i class="ti ti-chevron-${S.expandId===r.id?'up':'down'}" style="font-size:14px;color:#6b6b67;flex-shrink:0"></i>
        </div>
      </div>
      ${S.expandId===r.id ? renderExpanded(r) : ''}`).join('')}
  </div>`;
}

function renderExpanded(r) {
  const hasActual = !!r.actual_last_lift_time;
  return `<div class="expand-panel">
  <div class="ep-title">Phase 1 \u2014 prediction</div>
  <div class="rbox" style="margin-bottom:8px">
    <div class="rrow"><span>QC / CMPH</span><span class="rval">${r.qc_number} \u00b7 ${r.cmph} CMPH</span></div>
    <div class="rrow"><span>Container time</span><span class="rval">${parseFloat(r.container_min).toFixed(1)} min</span></div>
    <div class="rrow"><span>Gantry + breakdown</span><span class="rval">${parseFloat(r.gantry_min).toFixed(1)} + ${r.buffer_min} min</span></div>
    <div class="rrow"><span>Total operation time</span><span class="rval">${parseFloat(r.total_min).toFixed(1)} min</span></div>
    <div class="rrow"><span>Predicted last lift</span><span class="rval" style="color:#185FA5">${r.predicted_last_lift_time}</span></div>
    <div class="rrow"><span>Suggested SRT</span><span class="rval" style="color:#0F6E56">${r.suggested_srt}</span></div>
    ${r.remarks ? `<div class="rrow"><span>Remarks</span><span style="font-size:11px;color:#6b6b67;max-width:55%;text-align:right">${r.remarks}</span></div>` : ''}
  </div>
  ${hasActual ? `
  <div class="ep-title" style="margin-top:10px">Phase 2 \u2014 actual</div>
  <div class="rbox">
    <div class="rrow"><span>Actual last lift</span><span class="rval">${r.actual_last_lift_time}</span></div>
    <div class="rrow"><span>Pilot onboard</span><span class="rval">${r.actual_pilot_onboard_time}</span></div>
    <div class="rrow"><span>Actual SRT</span><span class="rval">${r.actual_srt_time}</span></div>
    <div class="rrow"><span>SRT compliance window</span><span class="rval">${r.srt_window_start} \u2013 ${r.srt_window_end}</span></div>
    <div class="rrow"><span>Suggested SRT was</span><span class="rval" style="color:${r.booking_quality==='GOOD'?'#0F6E56':'#A32D2D'}">${r.suggested_srt} \u2192 ${r.booking_quality}</span></div>
    <div class="rrow"><span>Deviation (pred vs actual LL)</span><span class="rval" style="color:${Math.abs(r.deviation_minutes)<=30?'#0F6E56':'#A32D2D'}">${r.deviation_minutes>0?'+':''}${r.deviation_minutes} min</span></div>
    <div class="rrow"><span>Remarks</span><span style="font-size:11px;color:#6b6b67;max-width:55%;text-align:right">${r.actual_remarks}</span></div>
  </div>` : `
  <div class="ep-title" style="margin-top:10px">Phase 2 \u2014 enter actual data</div>
  <div class="time-group">
    <div class="fi"><label>Actual last lift</label>
      <div class="iw" style="gap:0">
        <input type="number" id="a-ll-h" placeholder="HH" min="0" max="23" maxlength="2" style="text-align:center;flex:1" oninput="hhmmAutoAdvance(this,'a-ll-m')">
        <span style="padding:0 4px;color:#6b6b67;font-size:16px;flex-shrink:0">:</span>
        <input type="number" id="a-ll-m" placeholder="MM" min="0" max="59" maxlength="2" style="text-align:center;flex:1">
      </div>
    </div>
    <div class="fi"><label>Pilot onboard</label>
      <div class="iw" style="gap:0">
        <input type="number" id="a-po-h" placeholder="HH" min="0" max="23" maxlength="2" style="text-align:center;flex:1" oninput="hhmmAutoAdvance(this,'a-po-m')">
        <span style="padding:0 4px;color:#6b6b67;font-size:16px;flex-shrink:0">:</span>
        <input type="number" id="a-po-m" placeholder="MM" min="0" max="59" maxlength="2" style="text-align:center;flex:1">
      </div>
    </div>
    <div class="fi"><label>Actual SRT</label>
      <div class="iw" style="gap:0">
        <input type="number" id="a-srt-h" placeholder="HH" min="0" max="23" maxlength="2" style="text-align:center;flex:1" oninput="hhmmAutoAdvance(this,'a-srt-m')">
        <span style="padding:0 4px;color:#6b6b67;font-size:16px;flex-shrink:0">:</span>
        <input type="number" id="a-srt-m" placeholder="MM" min="0" max="59" maxlength="2" style="text-align:center;flex:1">
      </div>
    </div>
  </div>
  <div class="fi" style="margin-bottom:9px">
    <label>Remarks <span style="font-size:10px;color:#6b6b67">(mandatory)</span></label>
    <textarea id="a-rem" rows="2" placeholder="What happened \u2014 early completion, breakdown, vessel delay, etc."></textarea>
  </div>
  <button class="btn btn-green" onclick="savePhase2('${r.id}')">Save actual data</button>`}
  </div>`;
}

function renderDashboard(tb) {
  const weekKeys = Array.from(new Set(S.records.map(r => getWeekKey(new Date(r.created_at))))).sort().reverse();
  const monthKeys = Array.from(new Set(S.records.map(r => getMonthKey(new Date(r.created_at))))).sort().reverse();

  let baseRecords = S.records;
  if (S.monthFilter !== 'all') baseRecords = baseRecords.filter(r => getMonthKey(new Date(r.created_at)) === S.monthFilter);
  if (S.weekFilter !== 'all') baseRecords = baseRecords.filter(r => getWeekKey(new Date(r.created_at)) === S.weekFilter);

  const done = baseRecords.filter(r => r.actual_last_lift_time);
  const good = done.filter(r => r.booking_quality === 'GOOD');
  const notQ = done.filter(r => r.booking_quality === 'NOT QUALITY');
  const avgDev = done.length ? Math.round(done.reduce((s,r) => s + Math.abs(r.deviation_minutes), 0) / done.length) : 0;
  const srtRate = done.length ? Math.round(good.length / done.length * 100) : 0;
  const isFiltered = S.weekFilter !== 'all' || S.monthFilter !== 'all';

  tb.innerHTML = `
  <div class="filter-row">
    <div class="fi">
      <label>Month</label>
      <div class="iw"><select onchange="S.monthFilter=this.value;renderTab()">
        <option value="all" ${S.monthFilter==='all'?'selected':''}>All months</option>
        ${monthKeys.map(mk => `<option value="${mk}" ${S.monthFilter===mk?'selected':''}>${formatMonthLabel(mk)}</option>`).join('')}
      </select></div>
    </div>
    <div class="fi">
      <label>Workweek (Mon\u2013Sun)</label>
      <div class="iw"><select onchange="S.weekFilter=this.value;renderTab()">
        <option value="all" ${S.weekFilter==='all'?'selected':''}>All weeks</option>
        ${weekKeys.map(wk => `<option value="${wk}" ${S.weekFilter===wk?'selected':''}>${formatWeekLabel(wk)}</option>`).join('')}
      </select></div>
    </div>
  </div>
  <div class="g4" style="margin-bottom:10px">
    <div class="metric"><div class="mlabel">Total predictions</div><div class="mval">${baseRecords.length}</div><div class="msub">${isFiltered?'filtered':'all time'}</div></div>
    <div class="metric"><div class="mlabel">Validated</div><div class="mval">${done.length}</div><div class="msub">with actual data</div></div>
    <div class="metric"><div class="mlabel">SRT compliance</div><div class="mval" style="color:${srtRate>=80?'#0F6E56':srtRate>=60?'#854F0B':'#A32D2D'}">${srtRate}%</div><div class="msub">${good.length} GOOD \u00b7 ${notQ.length} NOT QUALITY</div></div>
    <div class="metric"><div class="mlabel">Avg LL deviation</div><div class="mval">${avgDev} min</div><div class="msub">predicted vs actual</div></div>
  </div>
  ${done.length < 1 ? `<div class="card empty">Complete some records first to see analytics.</div>` : `
  <div class="card">
    <div class="ctitle">SRT compliance</div>
    <div style="display:flex;gap:16px;font-size:11px;color:#6b6b67;margin-bottom:8px;flex-wrap:wrap">
      <span style="display:flex;align-items:center;gap:4px"><span style="width:9px;height:9px;border-radius:2px;background:#639922;display:inline-block"></span>GOOD (${good.length})</span>
      <span style="display:flex;align-items:center;gap:4px"><span style="width:9px;height:9px;border-radius:2px;background:#E24B4A;display:inline-block"></span>NOT QUALITY (${notQ.length})</span>
    </div>
    <div style="position:relative;width:100%;height:180px"><canvas id="ch-q" role="img" aria-label="SRT compliance chart">${good.length} GOOD, ${notQ.length} NOT QUALITY.</canvas></div>
  </div>
  <div class="card">
    <div class="ctitle">Last lift deviation \u2014 last 12 records</div>
    <div style="display:flex;gap:16px;font-size:11px;color:#6b6b67;margin-bottom:8px;flex-wrap:wrap">
      <span style="display:flex;align-items:center;gap:4px"><span style="width:9px;height:9px;border-radius:2px;background:#378ADD;display:inline-block"></span>Within 30 min</span>
      <span style="display:flex;align-items:center;gap:4px"><span style="width:9px;height:9px;border-radius:2px;background:#E24B4A;display:inline-block"></span>Over 30 min</span>
    </div>
    <div style="position:relative;width:100%;height:200px"><canvas id="ch-d" role="img" aria-label="Deviation chart">Deviation in minutes per vessel.</canvas></div>
  </div>
  <div class="card">
    <div class="ctitle">Recent completed records</div>
    <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Date</th><th>Vessel</th><th>QC</th>
        <th>Pred LL</th><th>Actual LL</th>
        <th>SRT</th><th>Dev</th><th>Quality</th><th>SRT Gap</th>
      </tr></thead>
      <tbody>${done.slice(0,10).map(r => {
        const srtGap = Math.round((parseT(r.actual_last_lift_time) - parseT(r.suggested_srt)) / 60000);
        return `<tr>
        <td style="font-family:monospace">${new Date(r.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short'})}</td>
        <td>${r.vessel_name}</td>
        <td style="font-family:monospace">${r.qc_number}</td>
        <td style="font-family:monospace">${r.predicted_last_lift_time}</td>
        <td style="font-family:monospace">${r.actual_last_lift_time}</td>
        <td style="font-family:monospace">${r.suggested_srt}</td>
        <td style="font-family:monospace;color:${Math.abs(r.deviation_minutes)<=30?'#0F6E56':'#A32D2D'}">${r.deviation_minutes>0?'+':''}${r.deviation_minutes}</td>
        <td><span class="badge ${r.booking_quality==='GOOD'?'bg':'bb'}">${r.booking_quality}</span></td>
        <td style="font-family:monospace;color:${r.booking_quality==='GOOD'?'#0F6E56':'#A32D2D'}">${srtGap>0?'+':''}${srtGap} min</td>
      </tr>`;
      }).join('')}</tbody>
    </table>
    </div>
  </div>`}`;

  if (done.length >= 1) {
    setTimeout(() => {
      if (document.getElementById('ch-q')) {
        new Chart(document.getElementById('ch-q'), {
          type: 'doughnut',
          data: { labels:['GOOD','NOT QUALITY'], datasets:[{ data:[good.length,notQ.length], backgroundColor:['#639922','#E24B4A'], borderWidth:0 }] },
          options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false } }, cutout:'65%' }
        });
      }
      const last12 = done.slice(0,12).reverse();
      if (document.getElementById('ch-d')) {
        new Chart(document.getElementById('ch-d'), {
          type: 'bar',
          data: { labels: last12.map(r => r.vessel_name.slice(0,10)), datasets:[{ data: last12.map(r => r.deviation_minutes), backgroundColor: last12.map(r => Math.abs(r.deviation_minutes)<=30?'#378ADD':'#E24B4A'), borderWidth:0, borderRadius:3 }] },
          options: { responsive:true, maintainAspectRatio:false, scales:{ y:{ grid:{ color:'rgba(0,0,0,.06)' }, ticks:{ font:{size:10} } }, x:{ ticks:{ autoSkip:false, maxRotation:35, font:{size:10} } } }, plugins:{ legend:{ display:false } } }
        });
      }
    }, 150);
  }
}

window.doLogin = function() {
  const v = document.getElementById('op-inp')?.value.trim().toUpperCase();
  if (!v) { alert('Please enter your employee ID.'); return; }
  S.operator = v;
  localStorage.setItem('ptp_op', v);
  loadRecords().then(() => R());
};

window.doLogout = function() {
  S.operator = '';
  S.records = [];
  localStorage.removeItem('ptp_op');
  R();
};

window.setTab = function(t) {
  S.tab = t;
  S.result = null;
  R();
  if (t === 'records' || t === 'dashboard') loadRecords();
};

window.onQC = function(v) { syncForm(); S.form.qc = v; renderTab(); };
window.toggleExp = function(id) { S.expandId = S.expandId===id ? null : id; renderTab(); };

window.hhmmAutoAdvance = function(hourInput, minuteId) {
  if (hourInput.value.length >= 2) {
    hourInput.value = Math.min(23, Math.max(0, +hourInput.value));
    const minEl = document.getElementById(minuteId);
    if (minEl) minEl.focus();
  }
};

window.doCalc = function() {
  syncForm();
  const f = S.form;
  if (!f.vessel) { alert('Please enter the vessel name.'); return; }
  if (!f.qc) { alert('Please select a QC number.'); return; }
  if (!f.cmph || +f.cmph <= 0) { alert('Please enter CMPH.'); return; }
  const qc = QC_DB.find(q => q.qc === f.qc);
  const res = calcAll(f, +f.cmph, qc ? qc.speed : 50);
  const now = new Date();
  const lastLift = addMin(now, res.totalMin);
  S.result = { ...res, lastLiftStr: toHM(lastLift), srtStr: toHM(lastLift) };
  renderTab();
  setTimeout(() => { const el = document.querySelector('.hrow'); if (el) el.scrollIntoView({ behavior:'smooth', block:'nearest' }); }, 100);
};

window.savePhase1 = async function() {
  syncForm();
  const rem = document.getElementById('p1-rem')?.value.trim() || '';
  const f = S.form; const r = S.result;
  const qc = QC_DB.find(q => q.qc === f.qc);
  const rec = {
    id: genId(), vessel_name: f.vessel, qc_number: f.qc,
    qc_model: qc?.model||'', qc_speed: qc?.speed||50, cmph: +f.cmph,
    f1:+f.f1, f2:+f.f2, f3:+f.f3, f4:+f.f4, f5:+f.f5, f6:+f.f6, f7:+f.f7, f8:+f.f8,
    container_min: r.containerMin, gantry_min: r.gantryMin,
    buffer_min: r.bufferMin, total_min: r.totalMin,
    predicted_last_lift_time: r.lastLiftStr, suggested_srt: r.srtStr,
    operator_id: S.operator, remarks: rem,
    created_at: new Date().toISOString()
  };
  const ok = await dbInsert(rec);
  if (!ok) return;
  S.result = null;
  S.form = { vessel:'', qc:'', cmph:'', f1:0, f2:0, f3:0, f4:0, f5:0, f6:0, f7:0, f8:0 };
  alert('Saved: ' + rec.vessel_name + '\nRecommended SRT: ' + rec.suggested_srt);
  S.tab = 'records'; S.recTab = 'pending';
  await loadRecords();
  R();
};

window.savePhase2 = async function(id) {
  const readHM = (hId, mId) => {
    const h = document.getElementById(hId)?.value;
    const m = document.getElementById(mId)?.value;
    if (h === '' || h === null || m === '' || m === null) return null;
    const hh = String(Math.min(23, Math.max(0, +h))).padStart(2,'0');
    const mm = String(Math.min(59, Math.max(0, +m))).padStart(2,'0');
    return hh + ':' + mm;
  };
  const ll = readHM('a-ll-h', 'a-ll-m');
  const po = readHM('a-po-h', 'a-po-m');
  const srt = readHM('a-srt-h', 'a-srt-m');
  const rem = document.getElementById('a-rem')?.value.trim();
  if (!ll || !po || !srt) { alert('All three time fields are mandatory.'); return; }
  if (!rem) { alert('Remarks are mandatory.'); return; }
  const rec = S.records.find(r => r.id === id);
  const srtWindowStart = toHM(addMin(parseT(rec.suggested_srt), -15));
  const quality = classifyQuality(rec.suggested_srt, ll);
  const deviation = Math.round((parseT(ll) - parseT(rec.predicted_last_lift_time)) / 60000);
  const ok = await dbUpdate(id, {
    actual_last_lift_time: ll, actual_pilot_onboard_time: po, actual_srt_time: srt,
    srt_window_start: srtWindowStart, srt_window_end: rec.suggested_srt, booking_quality: quality,
    deviation_minutes: deviation, actual_remarks: rem
  });
  if (!ok) return;
  S.expandId = null;
  await loadRecords();
  renderTab();
};

// ── BOOT ──────────────────────────────────────────────
(function boot() {
  if (window.supabase && window.sb) {
    loadQCDatabase().then(() => {
      if (S.operator) loadRecords().then(() => R());
      else R();
    });
  } else {
    setTimeout(boot, 100);
  }
})();
