'use strict';
(function () {

/* ============================================================
   CONSTANTS
   ============================================================ */
const STORAGE_KEY = 'generic_report_v1';
const CHART_COLORS = { teal: '#107C10', rust: '#D13438', brass: '#118DFF', ivory: '#252423', ivoryDim: '#605E5C', grid: 'rgba(0,0,0,0.08)' };
const PBI_PALETTE = ['#118DFF', '#12239E', '#E66C37', '#6B007B', '#E044A7', '#744EC2', '#D9B300', '#D64550'];
const DOMAIN_OPTIONS = ['Retail / E-commerce', 'Healthcare', 'Finance / Banking', 'SaaS / Technology', 'Manufacturing',
  'Human Resources', 'Marketing / Advertising', 'Education', 'Logistics / Supply Chain', 'Real Estate', 'Nonprofit', 'Other'];

const state = {
  mode: 'single', // 'single' | 'compare'
  rawRows: [], columns: [], fullProfiles: [],
  businessContext: { description: '', domain: '', domainOther: '', expectations: '' },
  filters: {}, filterableColumns: [], headlineKpiNames: [],
  activeTab: 'overview', renderedTabs: new Set(), charts: {},
  meta: { fileName: '', uploadedAt: '', rowCount: 0 },
  dateColumn: null, duplicateRowCount: 0,
  // Comparison mode
  periods: [],              // array of slot states: null (empty) | {status:'loading'|'error'|'ready', ...}
  comparisonData: null,     // output of buildPeriodComparison once all periods are ready
};
const MAX_COMPARE_PERIODS = 6;

/* ============================================================
   MATH / STATS UTILITIES (unchanged, domain-agnostic)
   ============================================================ */
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function quantile(sortedArr, q) {
  if (!sortedArr.length) return null;
  const pos = (sortedArr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedArr[base + 1] !== undefined) return sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base]);
  return sortedArr[base];
}
function median(arr) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return quantile(s, 0.5); }
function mode(arr) { const counts = {}; let best = null, bestCount = -1; arr.forEach(v => { counts[v] = (counts[v] || 0) + 1; if (counts[v] > bestCount) { bestCount = counts[v]; best = v; } }); return best; }
function stddev(arr, m) { if (arr.length < 2) return 0; const mu = m !== undefined ? m : mean(arr); return Math.sqrt(arr.reduce((a, b) => a + (b - mu) * (b - mu), 0) / arr.length); }
function pearson(pairs) {
  const n = pairs.length; if (n < 2) return null;
  let sx = 0, sy = 0; pairs.forEach(([x, y]) => { sx += x; sy += y; });
  const mx = sx / n, my = sy / n;
  let num = 0, dx2 = 0, dy2 = 0;
  pairs.forEach(([x, y]) => { const dx = x - mx, dy = y - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; });
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}
function iqrOutliers(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1, lower = q1 - 1.5 * iqr, upper = q3 + 1.5 * iqr;
  return { q1, q3, iqr, lower, upper, count: values.filter(v => v < lower || v > upper).length, min: sorted[0], max: sorted[sorted.length - 1] };
}

/* ============================================================
   FORMATTING HELPERS
   ============================================================ */
function escapeHtml(str) { return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtPct(x, d) { return x == null || isNaN(x) ? '—' : (x * 100).toFixed(d == null ? 1 : d) + '%'; }
function fmtNum(x, d) { return x == null || isNaN(x) ? '—' : Number(x).toLocaleString(undefined, { minimumFractionDigits: d || 0, maximumFractionDigits: d == null ? 2 : d }); }
function fmtInt(x) { return x == null || isNaN(x) ? '—' : Math.round(x).toLocaleString(); }
function fmtSmart(x, profile) {
  if (x == null || isNaN(x)) return '—';
  if (profile && profile.valueType === 'currency_numeric') {
    const sign = x < 0 ? '-' : '';
    return sign + '$' + Math.abs(Number(x)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (profile && profile.valueType === 'percent_numeric') return Number(x).toFixed(1) + '%';
  return Math.abs(x) >= 1000 ? fmtInt(x) : fmtNum(x, 2);
}
function fmtDate(d) { return d instanceof Date && !isNaN(d) ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'; }

/* ============================================================
   GENERIC COLUMN ENGINE (verified against synthetic business data)
   ============================================================ */
function tokenizeColumnName(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}
function detectColumnRole(name) {
  const tokens = tokenizeColumnName(name);
  const has = (...words) => words.some(w => tokens.includes(w));
  if (has('id', 'code', 'key', 'no', 'num', 'number')) return 'identifier';
  if (has('date', 'time', 'dt', 'created', 'updated', 'timestamp')) return 'date';
  if (has('price', 'amount', 'revenue', 'sales', 'cost', 'fee', 'total', 'salary', 'income', 'budget', 'profit', 'expense', 'value', 'fare')) return 'currency';
  if (has('qty', 'quantity', 'count', 'units', 'unit', 'stock', 'inventory', 'volume')) return 'quantity';
  if (has('percent', 'pct', 'rate', 'score', 'ratio')) return 'percentage';
  if (has('email', 'phone', 'address', 'contact')) return 'contact';
  if (has('name', 'title')) return 'name';
  if (has('category', 'type', 'status', 'region', 'department', 'segment', 'group', 'class', 'gender', 'country', 'city', 'state', 'channel', 'platform')) return 'category';
  return 'unknown';
}
const ROLE_LABELS = { identifier: 'Identifier', date: 'Date / Time', currency: 'Currency / Value', quantity: 'Quantity', percentage: 'Rate / Percentage', contact: 'Contact Info', name: 'Name', category: 'Category', unknown: 'General' };
const TYPE_LABELS = { numeric: 'Numeric', currency_numeric: 'Currency', percent_numeric: 'Percentage', boolean: 'Boolean', date: 'Date', categorical: 'Categorical', text: 'Text' };

function detectColumnType(rawValues) {
  const n = rawValues.length;
  const trimmed = rawValues.map(v => String(v).trim());
  const uniqLower = new Set(trimmed.map(v => v.toLowerCase()));
  const boolSets = [['true', 'false'], ['yes', 'no'], ['y', 'n']];
  for (const set of boolSets) {
    if (uniqLower.size <= 2 && [...uniqLower].every(v => set.includes(v))) return 'boolean';
  }
  const cleaned = trimmed.map(v => v.replace(/[$,€£%]/g, '').trim());
  const numericOk = cleaned.filter(v => v !== '' && !isNaN(Number(v))).length;
  const isCurrency = trimmed.some(v => /[$€£]/.test(v));
  const isPercent = trimmed.some(v => /%\s*$/.test(v));
  if (numericOk / n >= 0.99) return isCurrency ? 'currency_numeric' : isPercent ? 'percent_numeric' : 'numeric';
  let dateOk = 0;
  const DATE_LIKE_RE = /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}(?:[T\s].*)?$|^\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4}$|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
  trimmed.forEach(v => { const t = Date.parse(v); if (!isNaN(t) && DATE_LIKE_RE.test(v)) dateOk++; });
  if (dateOk / n >= 0.9) return 'date';
  const uniqCount = new Set(trimmed).size;
  if (uniqCount <= 5) return 'categorical';
  const hasRepeats = uniqCount < n;
  if (hasRepeats && (uniqCount <= 40 || uniqCount / n <= 0.5)) return 'categorical';
  return 'text';
}
function parseNumericCell(v) { if (v == null) return null; const c = String(v).replace(/[$,€£%]/g, '').trim(); if (c === '') return null; const n = Number(c); return isNaN(n) ? null : n; }

function profileColumn(name, rawValues) {
  const role = detectColumnRole(name);
  const valueType = detectColumnType(rawValues);
  const n = rawValues.length;
  const trimmed = rawValues.map(v => String(v).trim());
  const profile = { name, role, valueType, count: n, uniqueCount: new Set(trimmed).size };

  if (valueType === 'numeric' || valueType === 'currency_numeric' || valueType === 'percent_numeric') {
    const nums = trimmed.map(parseNumericCell).filter(v => v != null);
    const sorted = [...nums].sort((a, b) => a - b);
    profile.numeric = { sum: nums.reduce((a, b) => a + b, 0), mean: mean(nums), median: median(nums), min: sorted[0], max: sorted[sorted.length - 1], stddev: stddev(nums) };
    profile.outliers = nums.length > 4 ? iqrOutliers(nums) : null;
  } else if (valueType === 'date') {
    const dates = trimmed.map(v => new Date(v)).filter(d => !isNaN(d));
    const t = dates.map(d => d.getTime()).sort((a, b) => a - b);
    profile.date = { min: new Date(t[0]), max: new Date(t[t.length - 1]), spanDays: Math.round((t[t.length - 1] - t[0]) / 86400000) };
  } else if (valueType === 'categorical' || valueType === 'boolean') {
    const counts = {};
    trimmed.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    profile.categorical = { top: sorted.slice(0, 10).map(([value, count]) => ({ value, count, pct: count / n })), cardinality: sorted.length };
  } else {
    profile.text = { sampleValues: trimmed.slice(0, 3) };
  }
  return profile;
}

function findBlankColumns(rows, columns) {
  const byColumn = {};
  const log = [];
  rows.forEach((row, idx) => {
    columns.forEach(col => {
      const v = row[col];
      const isBlank = v === undefined || v === null || String(v).trim() === '';
      if (isBlank) {
        if (!byColumn[col]) byColumn[col] = { count: 0, exampleRows: [] };
        byColumn[col].count++;
        if (byColumn[col].exampleRows.length < 5) byColumn[col].exampleRows.push(idx + 2);
        log.push({ row: idx + 2, column: col });
      }
    });
  });
  return { byColumn, log };
}
function detectDuplicateRows(rows, columns) {
  const counts = {};
  rows.forEach(r => { const key = columns.map(c => r[c]).join('||'); counts[key] = (counts[key] || 0) + 1; });
  return Object.values(counts).filter(c => c > 1).reduce((a, c) => a + (c - 1), 0);
}

function selectHeadlineKpis(profiles) {
  const candidates = profiles.filter(p => ['numeric', 'currency_numeric', 'percent_numeric'].includes(p.valueType) && p.role !== 'identifier');
  const scored = candidates.map(p => ({ p, score: p.role === 'currency' ? 3 : p.role === 'quantity' ? 2 : p.role === 'percentage' ? 1 : 0 }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 6).map(s => s.p);
}
function selectFilterableColumns(profiles) {
  return profiles.filter(p => (p.valueType === 'categorical' || p.valueType === 'boolean') && p.categorical && p.categorical.cardinality >= 2 && p.categorical.cardinality <= 20)
    .sort((a, b) => a.categorical.cardinality - b.categorical.cardinality).slice(0, 4);
}
function computeGenericCorrelations(rows, numericProfiles) {
  const cols = numericProfiles.slice(0, 12);
  const matrix = {};
  cols.forEach(a => {
    matrix[a.name] = {};
    cols.forEach(b => {
      const pairs = rows.map(r => [parseNumericCell(r[a.name]), parseNumericCell(r[b.name])]).filter(([x, y]) => x != null && y != null);
      matrix[a.name][b.name] = a.name === b.name ? 1 : pearson(pairs);
    });
  });
  return { matrix, cols, truncated: numericProfiles.length > 12, totalNumeric: numericProfiles.length };
}
function buildTimeSeries(rows, dateCol, valueCol) {
  const parsed = rows.map(r => ({ d: new Date(typeof r[dateCol] === 'string' ? r[dateCol].trim() : r[dateCol]), v: parseNumericCell(r[valueCol]) })).filter(x => !isNaN(x.d));
  if (!parsed.length) return null;
  const times = parsed.map(x => x.d.getTime());
  const spanDays = (Math.max(...times) - Math.min(...times)) / 86400000;
  const granularity = spanDays > 60 ? 'month' : 'day';
  const buckets = {};
  parsed.forEach(({ d, v }) => {
    const key = granularity === 'month' ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : d.toISOString().slice(0, 10);
    if (!buckets[key]) buckets[key] = { sum: 0, count: 0 };
    buckets[key].count++;
    if (v != null) buckets[key].sum += v;
  });
  const keys = Object.keys(buckets).sort();
  return { granularity, labels: keys, sums: keys.map(k => buckets[k].sum), counts: keys.map(k => buckets[k].count) };
}

/* ============================================================
   DATASET ORCHESTRATOR
   ============================================================ */
function buildDataset(rawRows, columns) {
  const profiles = columns.map(col => profileColumn(col, rawRows.map(r => r[col])));
  const headlineKpis = selectHeadlineKpis(profiles);
  const filterableColumns = selectFilterableColumns(profiles);
  const dateProfile = profiles.find(p => p.valueType === 'date') || null;
  const numericProfiles = profiles.filter(p => ['numeric', 'currency_numeric', 'percent_numeric'].includes(p.valueType) && p.role !== 'identifier');
  const correlationResult = numericProfiles.length >= 2 ? computeGenericCorrelations(rawRows, numericProfiles) : null;
  const duplicateRowCount = detectDuplicateRows(rawRows, columns);
  return { profiles, headlineKpis, filterableColumns, dateColumn: dateProfile ? dateProfile.name : null, correlationResult, duplicateRowCount, numericProfiles };
}

/* ============================================================
   PERIOD COMPARISON ENGINE — compares 2+ CSVs with matching
   schemas as separate time periods (rather than one continuous
   file). Builds on the same per-file profiling above; this is
   purely the comparison layer on top.
   ============================================================ */
function sameColumnSet(a, b) {
  const setA = new Set(a), setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const c of setA) if (!setB.has(c)) return false;
  return true;
}
function columnSetDiff(a, b) {
  const setA = new Set(a), setB = new Set(b);
  return { onlyInA: a.filter(c => !setB.has(c)), onlyInB: b.filter(c => !setA.has(c)) };
}
const COMPARE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function deriveAutoLabel(dateInfo, fileName) {
  if (dateInfo) {
    const minY = dateInfo.min.getFullYear(), minM = dateInfo.min.getMonth();
    const maxY = dateInfo.max.getFullYear(), maxM = dateInfo.max.getMonth();
    if (minY === maxY && minM === maxM) return `${COMPARE_MONTHS[minM]} ${minY}`;
    if (minY === maxY) return `${COMPARE_MONTHS[minM]}\u2013${COMPARE_MONTHS[maxM]} ${minY}`;
    return `${COMPARE_MONTHS[minM]} ${minY} \u2013 ${COMPARE_MONTHS[maxM]} ${maxY}`;
  }
  return fileName.replace(/\.csv$/i, '').replace(/[_-]+/g, ' ').trim() || 'Period';
}
function computeSeriesDeltas(values) {
  return values.map((v, i) => {
    const fromPrev = i > 0 && values[i - 1] !== 0 ? (v - values[i - 1]) / Math.abs(values[i - 1]) : null;
    const fromFirst = i > 0 && values[0] !== 0 ? (v - values[0]) / Math.abs(values[0]) : null;
    return { value: v, fromPrev, fromFirst };
  });
}
function buildPeriodComparison(periods) {
  const columnNames = periods[0].columns;
  const numericComparisons = [];
  const categoricalComparisons = [];
  columnNames.forEach(colName => {
    const colProfiles = periods.map(p => p.profiles.find(pr => pr.name === colName));
    if (colProfiles.every(p => p && ['numeric', 'currency_numeric', 'percent_numeric'].includes(p.valueType) && p.role !== 'identifier')) {
      const series = periods.map((p, i) => ({ label: p.label, sum: colProfiles[i].numeric.sum, mean: colProfiles[i].numeric.mean, median: colProfiles[i].numeric.median, count: colProfiles[i].count }));
      numericComparisons.push({ name: colName, role: colProfiles[0].role, valueType: colProfiles[0].valueType, series, deltas: computeSeriesDeltas(series.map(s => s.sum)) });
    } else if (colProfiles.every(p => p && (p.valueType === 'categorical' || p.valueType === 'boolean') && p.role !== 'identifier' && p.categorical.cardinality >= 2)) {
      const series = periods.map((p, i) => ({ label: p.label, top: colProfiles[i].categorical.top, total: colProfiles[i].count }));
      categoricalComparisons.push({ name: colName, series });
    }
  });
  const headlineNames = Array.from(new Set(periods.flatMap(p => p.headlineKpiNames)));
  const headlineComparisons = numericComparisons.filter(c => headlineNames.includes(c.name))
    .sort((a, b) => headlineNames.indexOf(a.name) - headlineNames.indexOf(b.name));
  return { numericComparisons, categoricalComparisons, headlineComparisons, recordCounts: periods.map(p => ({ label: p.label, count: p.rawRows.length })) };
}
function generateComparisonFindings(periods, comparison) {
  const findings = [];
  const first = periods[0].label, last = periods[periods.length - 1].label;
  const firstCount = periods[0].rawRows.length, lastCount = periods[periods.length - 1].rawRows.length;
  if (firstCount > 0) {
    const pct = (lastCount - firstCount) / firstCount;
    if (Math.abs(pct) >= 0.05) findings.push({ type: 'volume', title: `Record volume ${pct >= 0 ? 'grew' : 'fell'} ${Math.abs(pct * 100).toFixed(1)}% from ${first} to ${last}`, pct, body: `${fmtInt(firstCount)} records in ${first}, ${fmtInt(lastCount)} in ${last}.` });
  }
  comparison.headlineComparisons.forEach(c => {
    const firstV = c.series[0].sum, lastV = c.series[c.series.length - 1].sum;
    if (firstV !== 0) {
      const pct = (lastV - firstV) / Math.abs(firstV);
      if (Math.abs(pct) >= 0.05) findings.push({ type: 'kpi', column: c.name, title: `${c.name} ${pct >= 0 ? 'grew' : 'declined'} ${Math.abs(pct * 100).toFixed(1)}% from ${first} to ${last}`, pct, body: `From ${fmtSmart(firstV, c)} to ${fmtSmart(lastV, c)}${periods.length > 2 ? ' across ' + periods.length + ' periods' : ''}.` });
    }
  });
  comparison.categoricalComparisons.forEach(c => {
    const firstTop = c.series[0].top[0];
    const lastTopEntry = c.series[c.series.length - 1].top[0];
    if (firstTop && lastTopEntry && firstTop.value !== lastTopEntry.value) {
      findings.push({ type: 'leadership', column: c.name, title: `${c.name}: "${lastTopEntry.value}" overtook "${firstTop.value}" as the leading value`, body: `"${firstTop.value}" led in ${first}; by ${last}, "${lastTopEntry.value}" had taken over.`, from: firstTop.value, to: lastTopEntry.value });
    }
  });
  return findings;
}

/* ============================================================
   RENDER PRIMITIVES — KPI cards, ledger tables, rate gauges, heatmaps
   ============================================================ */
function chartsAvailable() { return typeof Chart !== 'undefined'; }
function papaAvailable() { return typeof Papa !== 'undefined'; }
function destroyChart(id) { if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; } }
function setChartDefaults() {
  if (!chartsAvailable()) return;
  Chart.defaults.color = CHART_COLORS.ivoryDim;
  Chart.defaults.font.family = "'Source Sans 3', sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.borderColor = CHART_COLORS.grid;
}
function panel(titleHtml, bodyHtml, extraClass) {
  return `<div class="panel ${extraClass || ''}"><div class="panel-title">${titleHtml}</div>${bodyHtml}</div>`;
}
function kpiCardHtml(label, value, sub, subClass) {
  return `<div class="panel kpi-card"><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub ${subClass || ''}">${sub}</div>` : ''}</div>`;
}
function dataBarHtml(pct, opts) {
  opts = opts || {};
  if (pct == null || isNaN(pct)) return '<span class="small-n">—</span>';
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const fill = opts.color || 'rgba(17,141,255,0.20)';
  return `<div class="data-bar-cell"><div class="data-bar-fill" style="width:${p}%;background:${fill};"></div><span class="data-bar-text">${opts.suffix === '' ? p : p + '%'}</span></div>`;
}
function categoryTableHtml(entries, opts) {
  opts = opts || {};
  const catLabel = opts.catLabel || 'Value';
  const displayName = opts.displayName || (c => c);
  if (!entries.length) return '<p class="note-box">No data available for this breakdown.</p>';
  const maxCount = Math.max(...entries.map(e => e.count));
  const rows = entries.map(e => {
    const rowClass = (opts.highlightTop !== false && entries.length > 2 && e.count === maxCount) ? 'hi-row' : '';
    return `<tr class="${rowClass}"><td>${escapeHtml(displayName(e.value ?? e.category))}</td>
      <td class="num">${fmtInt(e.count)}</td><td>${dataBarHtml((e.pct != null ? e.pct : e.count / (opts.total || maxCount)) * 100)}</td></tr>`;
  }).join('');
  return `<div class="table-scroll"><table class="ledger"><thead><tr><th>${escapeHtml(catLabel)}</th><th class="num">Count</th><th>Share of Total</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}
function lerpColorAlpha(c1, c2, t, alpha) {
  const c = c1.map((v, i) => Math.round(v + (c2[i] - v) * t));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}
function heatBg(intensity) {
  // Neutral sequential scale (light -> saturated Power BI blue) for magnitude data with no inherent good/bad direction
  const r = Math.max(0, Math.min(1, intensity));
  return lerpColorAlpha([235, 244, 253], [17, 141, 255], r, 1);
}
function corrHeatBg(r) {
  // Diverging scale using the Power BI theme's own blue/orange: blue = negative, orange = positive
  if (r == null) return 'transparent';
  const a = Math.min(1, Math.abs(r));
  return r >= 0 ? `rgba(230,108,55,${0.08 + a * 0.35})` : `rgba(17,141,255,${0.08 + a * 0.35})`;
}
function crossTabCounts(rows, colA, colB) {
  const groups = {};
  rows.forEach(r => {
    const k1raw = r[colA], k2raw = r[colB];
    if (k1raw == null || k1raw === '' || k2raw == null || k2raw === '') return;
    const k1 = typeof k1raw === 'string' ? k1raw.trim() : k1raw;
    const k2 = typeof k2raw === 'string' ? k2raw.trim() : k2raw;
    const key = k1 + '||' + k2;
    if (!groups[key]) groups[key] = { k1, k2, count: 0 };
    groups[key].count++;
  });
  return Object.values(groups);
}
function crossHeatmapHtml(crossData, rowVals, colVals, rowLabelFn, colLabelFn) {
  const lookup = {};
  crossData.forEach(d => { lookup[d.k1 + '||' + d.k2] = d; });
  const maxCount = Math.max(1, ...crossData.map(d => d.count));
  const head = '<tr><th></th>' + colVals.map(c => `<th>${escapeHtml(colLabelFn(c))}</th>`).join('') + '</tr>';
  const body = rowVals.map(rv => {
    const cells = colVals.map(cv => {
      const d = lookup[rv + '||' + cv];
      if (!d) return '<td class="hm-cell">—</td>';
      return `<td class="hm-cell" style="background:${heatBg(d.count / maxCount)}">${fmtInt(d.count)}</td>`;
    }).join('');
    return `<tr><td class="hm-row-label">${escapeHtml(rowLabelFn(rv))}</td>${cells}</tr>`;
  }).join('');
  return `<div class="table-scroll"><table class="ledger heatmap"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/* ---- Chart.js wrappers (each degrades gracefully if the CDN failed) ---- */
function barChart(canvasId, labels, values, opts) {
  destroyChart(canvasId);
  const el = document.getElementById(canvasId);
  if (!el) return;
  if (!chartsAvailable()) { el.parentElement.innerHTML = '<div class="chart-empty">Chart library unavailable — see table below.</div>'; return; }
  opts = opts || {};
  state.charts[canvasId] = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ label: opts.label || 'Value', data: values, backgroundColor: opts.colors || CHART_COLORS.brass, borderRadius: 1, maxBarThickness: 40 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
      plugins: { legend: { display: false }, tooltip: opts.tooltipLabel ? { callbacks: { label: opts.tooltipLabel } } : {} },
      scales: {
        x: { grid: { display: false }, ticks: { color: CHART_COLORS.ivoryDim, maxRotation: opts.rotate || 0 } },
        y: { beginAtZero: true, max: opts.maxY, grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.ivoryDim, callback: opts.yTickCallback } },
      },
    },
  });
}
function donutChart(canvasId, labels, values, colors) {
  destroyChart(canvasId);
  const el = document.getElementById(canvasId);
  if (!el) return;
  if (!chartsAvailable()) { el.parentElement.innerHTML = '<div class="chart-empty">Chart library unavailable.</div>'; return; }
  state.charts[canvasId] = new Chart(el.getContext('2d'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: '#ffffff', borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '68%', animation: { duration: 400 }, plugins: { legend: { position: 'bottom', labels: { color: CHART_COLORS.ivoryDim, padding: 14, usePointStyle: true } } } },
  });
}
function histogramChart(canvasId, values, binCount, opts) {
  destroyChart(canvasId);
  const el = document.getElementById(canvasId);
  if (!el) return;
  if (!chartsAvailable() || !values.length) { el.parentElement.innerHTML = '<div class="chart-empty">No numeric data available.</div>'; return; }
  const min = Math.min(...values), max = Math.max(...values);
  const width = (max - min) / binCount || 1;
  const bins = new Array(binCount).fill(0);
  values.forEach(v => { let idx = Math.floor((v - min) / width); if (idx >= binCount) idx = binCount - 1; if (idx < 0) idx = 0; bins[idx]++; });
  const labels = bins.map((_, i) => fmtInt(min + i * width) + '–' + fmtInt(min + (i + 1) * width));
  state.charts[canvasId] = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data: bins, backgroundColor: (opts && opts.color) || CHART_COLORS.brass, borderRadius: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: { duration: 400 }, plugins: { legend: { display: false } },
      scales: { x: { grid: { display: false }, ticks: { color: CHART_COLORS.ivoryDim, maxRotation: 0, autoSkip: true, font: { size: 9.5 } } },
        y: { beginAtZero: true, grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.ivoryDim } } } },
  });
}
function pbiColors(n) { return Array.from({ length: n }, (_, i) => PBI_PALETTE[i % PBI_PALETTE.length]); }
function horizontalBarChart(canvasId, labels, values, opts) {
  destroyChart(canvasId);
  const el = document.getElementById(canvasId);
  if (!el) return;
  if (!chartsAvailable()) { el.parentElement.innerHTML = '<div class="chart-empty">Chart library unavailable.</div>'; return; }
  opts = opts || {};
  const colors = opts.colors || values.map(v => v >= 0 ? CHART_COLORS.teal : CHART_COLORS.rust);
  state.charts[canvasId] = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: 1 }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: { duration: 400 }, plugins: { legend: { display: false } },
      scales: { x: { grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.ivoryDim } }, y: { grid: { display: false }, ticks: { color: CHART_COLORS.ivoryDim, font: { size: 10.5 } } } } },
  });
}

/* ============================================================
   RULE-BASED BUSINESS INSIGHTS (fully offline)
   ============================================================ */
function domainLabel() {
  const bc = state.businessContext;
  return bc.domain === 'Other' && bc.domainOther ? bc.domainOther : (bc.domain || 'your business');
}
function generateRuleBasedFindings(rows, wd) {
  const findings = [];
  const n = rows.length;
  const profiles = wd.profiles;

  const dateP = profiles.find(p => p.name === state.dateColumn);
  if (dateP && dateP.date) {
    findings.push({ title: `Records span ${dateP.date.spanDays.toLocaleString()} days`, body: `This file covers <b>${escapeHtml(dateP.name)}</b> from <b>${fmtDate(dateP.date.min)}</b> to <b>${fmtDate(dateP.date.max)}</b>, across ${fmtInt(n)} records.` });
  }

  wd.headlineKpis.slice(0, 3).forEach(p => {
    if (!p.numeric) return;
    const label = p.role === 'currency' ? 'total value' : p.role === 'quantity' ? 'total volume' : 'total';
    findings.push({
      title: `${p.name}: ${fmtSmart(p.numeric.sum, p)} ${label}`,
      body: `Averaging <b>${fmtSmart(p.numeric.mean, p)}</b> per record (median <b>${fmtSmart(p.numeric.median, p)}</b>), ranging from ${fmtSmart(p.numeric.min, p)} to ${fmtSmart(p.numeric.max, p)}.`,
    });
  });

  const topCategorical = profiles.filter(p => p.valueType === 'categorical' && p.role !== 'identifier' && p.categorical.cardinality >= 2).sort((a, b) => b.categorical.top[0].pct - a.categorical.top[0].pct)[0];
  if (topCategorical) {
    const top = topCategorical.categorical.top[0];
    findings.push({ title: `"${top.value}" leads ${topCategorical.name}`, body: `<b>${escapeHtml(String(top.value))}</b> accounts for <b>${fmtPct(top.pct)}</b> of all records (${fmtInt(top.count)} of ${fmtInt(n)}) — the largest single group in <b>${escapeHtml(topCategorical.name)}</b>, which has ${topCategorical.categorical.cardinality} distinct values overall.` });
  }

  if (wd.correlationResult) {
    const { matrix, cols } = wd.correlationResult;
    let best = null;
    for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) {
      const r = matrix[cols[i].name][cols[j].name];
      if (r != null && (!best || Math.abs(r) > Math.abs(best.r))) best = { a: cols[i].name, b: cols[j].name, r };
    }
    if (best && Math.abs(best.r) >= 0.3) {
      findings.push({ title: `${best.a} and ${best.b} move together`, body: `These two numeric fields have a ${best.r > 0 ? 'positive' : 'negative'} correlation of <b>${best.r.toFixed(2)}</b> across this dataset — worth investigating further, though this is an association, not proof that one causes the other.` });
    }
  }

  wd.headlineKpis.slice(0, 2).forEach(p => {
    if (p.outliers && p.outliers.count > 0) {
      findings.push({ title: `${p.outliers.count} outlier${p.outliers.count > 1 ? 's' : ''} in ${p.name}`, body: `Using the IQR method, ${p.outliers.count} record(s) fall outside ${fmtSmart(p.outliers.lower, p)}–${fmtSmart(p.outliers.upper, p)}. These are retained in every calculation, not removed — but may be worth a manual look.` });
    }
  });

  if (wd.duplicateRowCount > 0) {
    findings.push({ title: `${state.duplicateRowCount} duplicate row${state.duplicateRowCount > 1 ? 's' : ''} detected`, body: `These are fully identical records across every column. Consider whether they represent genuine repeat events or accidental duplication before relying on totals.` });
  }

  return findings.slice(0, 8);
}
function expectationRouting() {
  const text = (state.businessContext.expectations || '').toLowerCase();
  const routes = [];
  if (/trend|over time|month|growth|seasonal|time series/.test(text)) routes.push({ tab: 'trends', label: 'Trends' });
  if (/compare|category|breakdown|segment|by region|by product|group/.test(text)) routes.push({ tab: 'categories', label: 'Categories' });
  if (/relationship|correlat|impact|driver|influence|affect/.test(text)) routes.push({ tab: 'correlations', label: 'Correlations' });
  if (/quality|missing|clean|accura/.test(text)) routes.push({ tab: 'dataprofile', label: 'Data Profile' });
  return routes;
}

/* ============================================================
   AI-ENHANCED INSIGHTS (opt-in, via the Anthropic API in artifacts)
   ============================================================ */
function buildAiSummaryPayload() {
  const numericProfiles = state.fullProfiles.filter(p => ['numeric', 'currency_numeric', 'percent_numeric'].includes(p.valueType) && p.role !== 'identifier');
  const correlationResult = numericProfiles.length >= 2 ? computeGenericCorrelations(state.rawRows, numericProfiles) : null;
  return {
    dataset: { totalRecords: state.rawRows.length, totalColumns: state.fullProfiles.length, duplicateRows: state.duplicateRowCount },
    columns: state.fullProfiles.map(p => {
      const c = { name: p.name, type: TYPE_LABELS[p.valueType] || p.valueType, role: ROLE_LABELS[p.role] || p.role };
      if (p.numeric) Object.assign(c, { sum: round2(p.numeric.sum), mean: round2(p.numeric.mean), median: round2(p.numeric.median), min: round2(p.numeric.min), max: round2(p.numeric.max) });
      if (p.categorical) c.topValues = p.categorical.top.slice(0, 5).map(t => ({ value: t.value, pct: Math.round(t.pct * 1000) / 10 }));
      if (p.date) Object.assign(c, { minDate: p.date.min.toISOString().slice(0, 10), maxDate: p.date.max.toISOString().slice(0, 10), spanDays: p.date.spanDays });
      return c;
    }),
    topCorrelations: correlationResult ? topCorrelationPairs(correlationResult, 5) : [],
  };
}
function round2(x) { return x == null ? null : Math.round(x * 100) / 100; }
function topCorrelationPairs(corrResult, limit) {
  const { matrix, cols } = corrResult;
  const pairs = [];
  for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) {
    const r = matrix[cols[i].name][cols[j].name];
    if (r != null) pairs.push({ a: cols[i].name, b: cols[j].name, r: round2(r) });
  }
  pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  return pairs.slice(0, limit);
}
function simpleMarkdownToHtml(md) {
  const esc = escapeHtml(md);
  const bold = s => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const lines = esc.split('\n');
  let html = '', inList = false;
  lines.forEach(raw => {
    const l = raw.trim();
    if (l === '') { if (inList) { html += '</ul>'; inList = false; } return; }
    if (/^#{1,4}\s+/.test(l)) { if (inList) { html += '</ul>'; inList = false; } html += `<h4 class="ai-h">${bold(l.replace(/^#{1,4}\s+/, ''))}</h4>`; }
    else if (/^[-*]\s+/.test(l)) { if (!inList) { html += '<ul class="ai-list">'; inList = true; } html += `<li>${bold(l.replace(/^[-*]\s+/, ''))}</li>`; }
    else { if (inList) { html += '</ul>'; inList = false; } html += `<p class="ai-p">${bold(l)}</p>`; }
  });
  if (inList) html += '</ul>';
  return html;
}
async function callAiInsightsProxy(summary, businessContext, mode) {
  const response = await fetch('/api/ai-insights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary, businessContext, mode: mode || 'single' }),
  });
  let data = null;
  try { data = await response.json(); } catch (e) { /* non-JSON error response */ }
  if (!response.ok) throw new Error((data && data.error) || ('Request failed (' + response.status + ')'));
  if (!data || !data.text) throw new Error('Empty response from the server.');
  return data.text;
}
async function generateAiInsights() {
  const btn = document.getElementById('btn-generate-ai');
  const resultEl = document.getElementById('ai-insights-result');
  if (!btn || !resultEl) return;
  btn.disabled = true; btn.textContent = 'Generating…';
  resultEl.classList.remove('hidden');
  resultEl.innerHTML = '<div class="note-box">Contacting the AI service for a tailored analysis of your data…</div>';
  try {
    const summary = buildAiSummaryPayload();
    const text = await callAiInsightsProxy(summary, state.businessContext, 'single');
    resultEl.innerHTML = simpleMarkdownToHtml(text);
    btn.textContent = 'Regenerate AI Insights';
  } catch (e) {
    resultEl.innerHTML = `<div class="note-box warn"><strong>AI insights are unavailable right now.</strong> This feature calls the <code>/api/ai-insights</code> server function, which needs to be deployed with a valid Anthropic API key (see the project README for setup). The rule-based findings above already reflect the full analysis.</div>`;
    btn.textContent = 'Try Again';
  } finally {
    btn.disabled = false;
  }
}

/* ============================================================
   WORKING-DATA COMPUTATION (recomputed against filtered rows)
   ============================================================ */
function computeWorkingData(rows) {
  const profiles = state.columns.map(col => profileColumn(col, rows.map(r => r[col])));
  const byName = {};
  profiles.forEach(p => { byName[p.name] = p; });
  const headlineKpis = state.headlineKpiNames.map(n => byName[n]).filter(Boolean);
  const numericProfiles = profiles.filter(p => ['numeric', 'currency_numeric', 'percent_numeric'].includes(p.valueType) && p.role !== 'identifier');
  const correlationResult = numericProfiles.length >= 2 ? computeGenericCorrelations(rows, numericProfiles) : null;
  const duplicateRowCount = detectDuplicateRows(rows, state.columns);
  return { profiles, byName, headlineKpis, numericProfiles, correlationResult, duplicateRowCount };
}
function lineChart(canvasId, labels, values, opts) {
  destroyChart(canvasId);
  const el = document.getElementById(canvasId);
  if (!el) return;
  if (!chartsAvailable()) { el.parentElement.innerHTML = '<div class="chart-empty">Chart library unavailable.</div>'; return; }
  opts = opts || {};
  const color = opts.color || CHART_COLORS.brass;
  state.charts[canvasId] = new Chart(el.getContext('2d'), {
    type: 'line',
    data: { labels, datasets: [{ data: values, borderColor: color, backgroundColor: color + '22', fill: true, tension: 0.25, pointRadius: labels.length > 30 ? 0 : 3, borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 400 }, plugins: { legend: { display: false } },
      scales: { x: { grid: { display: false }, ticks: { color: CHART_COLORS.ivoryDim, maxRotation: 45, autoSkip: true, font: { size: 9.5 } } },
        y: { beginAtZero: true, grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.ivoryDim } } },
    },
  });
}

/* ============================================================
   TAB RENDERERS
   ============================================================ */
function renderOverview(rows) {
  const container = document.getElementById('tab-overview');
  const wd = computeWorkingData(rows);
  const bc = state.businessContext;

  const contextPanel = panel('Report Context', `<div class="grid grid-3">
      <div><div class="kpi-label">Business Domain</div><div style="font-size:13px;font-weight:600;">${escapeHtml(domainLabel())}</div></div>
      <div><div class="kpi-label">About This File</div><div class="wrap-cell" style="font-size:12.5px;color:var(--text-secondary);">${escapeHtml(bc.description)}</div></div>
      <div><div class="kpi-label">What You're Looking For</div><div class="wrap-cell" style="font-size:12.5px;color:var(--text-secondary);">${escapeHtml(bc.expectations)}</div></div>
    </div>`);

  const dateP = state.dateColumn ? wd.byName[state.dateColumn] : null;
  const kpiRow1 = `<div class="grid grid-4">
    ${kpiCardHtml('Total Records', fmtInt(rows.length))}
    ${kpiCardHtml('Columns', fmtInt(state.columns.length))}
    ${kpiCardHtml('Date Range', dateP && dateP.date ? fmtInt(dateP.date.spanDays + 1) + '<span class="unit">days</span>' : '—', dateP && dateP.date ? fmtDate(dateP.date.min) + ' – ' + fmtDate(dateP.date.max) : 'No date column detected')}
    ${kpiCardHtml('Data Quality', 'Clean', wd.duplicateRowCount > 0 ? fmtInt(wd.duplicateRowCount) + ' duplicate row(s) found' : 'No blanks · no duplicates', wd.duplicateRowCount > 0 ? 'neg' : 'pos')}
  </div>`;

  const kpiCards = wd.headlineKpis.map(p => p.numeric ? kpiCardHtml(p.name, fmtSmart(p.numeric.sum, p), 'avg ' + fmtSmart(p.numeric.mean, p) + ' / record') : '').join('');
  const kpiRow2 = wd.headlineKpis.length
    ? `<div class="grid grid-3" style="margin-top:12px;">${kpiCards}</div>`
    : `<div class="note-box" style="margin-top:12px;">No numeric columns were auto-detected as headline KPIs (e.g. revenue, quantity). See the Data Profile tab for the complete column-by-column breakdown.</div>`;

  const slots = [];
  if (state.dateColumn && wd.headlineKpis[0]) slots.push({ title: `Trend — ${wd.headlineKpis[0].name}`, id: 'chart-overview-a', kind: 'trend', kpi: wd.headlineKpis[0] });
  const topCat = wd.profiles.find(p => p.valueType === 'categorical' && p.role !== 'identifier' && p.categorical.cardinality >= 2);
  if (topCat) slots.push({ title: `Distribution — ${topCat.name}`, id: slots.length ? 'chart-overview-b' : 'chart-overview-a', kind: 'cat', profile: topCat });
  if (slots.length < 2 && wd.headlineKpis[1]) slots.push({ title: `${wd.headlineKpis[1].name} vs ${wd.headlineKpis[0] ? wd.headlineKpis[0].name : ''}`, id: 'chart-overview-b', kind: 'noop' });

  const chartsHtml = slots.length
    ? `<div class="grid grid-2" style="margin-top:12px;">${slots.map(s => panel(escapeHtml(s.title), `<div class="chart-canvas-wrap short"><canvas id="${s.id}"></canvas></div>`)).join('')}</div>`
    : '';

  container.innerHTML = `<div class="tab-panel-head"><h2>Overview</h2><p>A first read of your data, framed for ${escapeHtml(domainLabel())}.</p></div>
    ${contextPanel}<div class="section-divider"></div>${kpiRow1}${kpiRow2}${chartsHtml}`;

  slots.forEach(s => {
    if (s.kind === 'trend') {
      const ts = buildTimeSeries(rows, state.dateColumn, s.kpi.name);
      if (ts) lineChart(s.id, ts.labels, ts.sums.map(v => Math.round(v * 100) / 100));
    } else if (s.kind === 'cat') {
      const top = s.profile.categorical.top.slice(0, 6);
      barChart(s.id, top.map(t => String(t.value)), top.map(t => t.count), { colors: pbiColors(top.length) });
    }
  });
}

function renderDataProfile(rows) {
  const container = document.getElementById('tab-dataprofile');
  const profiles = state.fullProfiles;
  const cards = profiles.map(p => {
    let statsHtml = '';
    if (p.numeric) {
      statsHtml = `<div class="grid grid-3" style="gap:8px;">
        <div><div class="kpi-label">Sum</div><div class="prof-stat">${fmtSmart(p.numeric.sum, p)}</div></div>
        <div><div class="kpi-label">Mean</div><div class="prof-stat">${fmtSmart(p.numeric.mean, p)}</div></div>
        <div><div class="kpi-label">Median</div><div class="prof-stat">${fmtSmart(p.numeric.median, p)}</div></div>
        <div><div class="kpi-label">Min</div><div class="prof-stat">${fmtSmart(p.numeric.min, p)}</div></div>
        <div><div class="kpi-label">Max</div><div class="prof-stat">${fmtSmart(p.numeric.max, p)}</div></div>
        <div><div class="kpi-label">Std Dev</div><div class="prof-stat">${fmtSmart(p.numeric.stddev, p)}</div></div>
      </div>${p.outliers && p.outliers.count > 0 ? `<div class="note-box" style="margin-top:8px;">${p.outliers.count} statistical outlier(s) detected (IQR method).</div>` : ''}`;
    } else if (p.date) {
      statsHtml = `<div class="grid grid-3" style="gap:8px;">
        <div><div class="kpi-label">Earliest</div><div class="prof-stat">${fmtDate(p.date.min)}</div></div>
        <div><div class="kpi-label">Latest</div><div class="prof-stat">${fmtDate(p.date.max)}</div></div>
        <div><div class="kpi-label">Span</div><div class="prof-stat">${fmtInt(p.date.spanDays)}<span class="unit">days</span></div></div>
      </div>`;
    } else if (p.categorical) {
      statsHtml = `<div>${p.categorical.top.slice(0, 5).map(t => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;"><span class="wrap-cell" style="font-size:12px;min-width:100px;max-width:140px;color:var(--text-secondary);">${escapeHtml(String(t.value))}</span>${dataBarHtml(t.pct * 100)}</div>`).join('')}
        ${p.categorical.cardinality > 5 ? `<div class="small-n">+${p.categorical.cardinality - 5} more distinct value(s)</div>` : ''}</div>`;
    } else if (p.text) {
      statsHtml = `<div class="small-n wrap-cell">Example values: ${p.text.sampleValues.map(v => escapeHtml(v)).join(' · ')}</div>`;
    }
    return `<div class="panel" style="margin-bottom:0;">
      <div class="panel-title"><span class="wrap-cell">${escapeHtml(p.name)}</span><span style="display:flex;gap:5px;flex:none;"><span class="pill pill-strong">${TYPE_LABELS[p.valueType] || p.valueType}</span><span class="pill pill-weak">${ROLE_LABELS[p.role] || p.role}</span></span></div>
      <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:10px;">${fmtInt(p.count)} values · ${fmtInt(p.uniqueCount)} unique</div>
      ${statsHtml}
    </div>`;
  }).join('');

  container.innerHTML = `<div class="tab-panel-head"><h2>Data Profile</h2><p>Every column, fully profiled — nothing skipped. This always reflects the complete uploaded file, independent of the filters above.</p></div>
    <div class="grid grid-2">${cards}</div>`;
}

function renderTrends(rows) {
  const container = document.getElementById('tab-trends');
  if (!state.dateColumn) {
    container.innerHTML = `<div class="tab-panel-head"><h2>Trends</h2></div><div class="note-box warn">No date/time column was detected in this file, so a time-based trend view isn't available. If your file does include a date, check that its values look like standard dates (e.g. 2024-01-15 or 1/15/2024) with no blanks.</div>`;
    return;
  }
  const wd = computeWorkingData(rows);
  const dateP = wd.byName[state.dateColumn];
  const kpisToChart = wd.headlineKpis.slice(0, 3);
  const kpiPanels = kpisToChart.map((p, i) => panel(escapeHtml(p.name) + ' Over Time', `<div class="chart-canvas-wrap"><canvas id="chart-trend-${i}"></canvas></div>`)).join('');
  const countPanel = panel('Record Count Over Time', '<div class="chart-canvas-wrap"><canvas id="chart-trend-count"></canvas></div>');

  container.innerHTML = `<div class="tab-panel-head"><h2>Trends</h2><p>Using <b>${escapeHtml(state.dateColumn)}</b> as the timeline${dateP.date ? ` (${fmtDate(dateP.date.min)} – ${fmtDate(dateP.date.max)})` : ''}.</p></div>
    <div class="grid grid-2">${countPanel}${kpiPanels}</div>
    ${!kpisToChart.length ? '<div class="note-box" style="margin-top:12px;">No numeric KPI columns were detected to trend alongside record count — see Data Profile for the full column list.</div>' : ''}`;

  const anyValueCol = kpisToChart[0] ? kpisToChart[0].name : state.columns[0];
  const tsCount = buildTimeSeries(rows, state.dateColumn, anyValueCol);
  if (tsCount) lineChart('chart-trend-count', tsCount.labels, tsCount.counts, { color: CHART_COLORS.brass });
  kpisToChart.forEach((p, i) => {
    const ts = buildTimeSeries(rows, state.dateColumn, p.name);
    if (ts) lineChart(`chart-trend-${i}`, ts.labels, ts.sums.map(v => Math.round(v * 100) / 100), { color: PBI_PALETTE[(i + 1) % PBI_PALETTE.length] });
  });
}

function renderCategories(rows) {
  const container = document.getElementById('tab-categories');
  const wd = computeWorkingData(rows);
  const catProfiles = wd.profiles.filter(p => (p.valueType === 'categorical' || p.valueType === 'boolean') && p.role !== 'identifier' && p.categorical.cardinality >= 2);

  if (!catProfiles.length) {
    container.innerHTML = `<div class="tab-panel-head"><h2>Categories</h2></div><div class="note-box">No categorical columns with meaningful variation were detected in this file.</div>`;
    return;
  }
  const panels = catProfiles.map((p, i) => {
    const top = p.categorical.top.slice(0, 8);
    return panel(`${escapeHtml(p.name)} <span class="tag">${p.categorical.cardinality} distinct</span>`,
      `<div class="chart-canvas-wrap short"><canvas id="chart-cat-${i}"></canvas></div>` + categoryTableHtml(top, { catLabel: p.name, total: rows.length }));
  }).join('');

  let crossHtml = '';
  const sortedByCard = [...catProfiles].sort((a, b) => a.categorical.cardinality - b.categorical.cardinality);
  if (sortedByCard.length >= 2) {
    const [c1, c2] = sortedByCard;
    const cross = crossTabCounts(rows, c1.name, c2.name);
    const v1 = c1.categorical.top.map(t => t.value);
    const v2 = c2.categorical.top.map(t => t.value);
    crossHtml = `<div class="section-divider"></div>${panel(`${escapeHtml(c1.name)} × ${escapeHtml(c2.name)}`, crossHeatmapHtml(cross, v1, v2, v => String(v), v => String(v)))}`;
  }

  container.innerHTML = `<div class="tab-panel-head"><h2>Categories</h2><p>How records break down across each categorical field.</p></div>
    <div class="grid grid-2">${panels}</div>${crossHtml}`;

  catProfiles.forEach((p, i) => {
    const top = p.categorical.top.slice(0, 8);
    barChart(`chart-cat-${i}`, top.map(t => String(t.value)), top.map(t => t.count), { colors: pbiColors(top.length) });
  });
}

function renderCorrelationsTab(rows) {
  const container = document.getElementById('tab-correlations');
  const wd = computeWorkingData(rows);
  if (!wd.correlationResult) {
    container.innerHTML = `<div class="tab-panel-head"><h2>Correlations</h2></div><div class="note-box">This file needs at least two numeric columns (excluding identifiers) to compute correlations.${wd.numericProfiles.length === 1 ? ' Only one was found: ' + escapeHtml(wd.numericProfiles[0].name) + '.' : ''}</div>`;
    return;
  }
  const { matrix, cols, truncated, totalNumeric } = wd.correlationResult;
  const head = '<tr><th></th>' + cols.map(c => `<th>${escapeHtml(c.name)}</th>`).join('') + '</tr>';
  const body = cols.map(a => {
    const cells = cols.map(b => {
      const r = matrix[a.name][b.name];
      const disp = r == null ? '—' : r.toFixed(2);
      return `<td class="hm-cell" style="background:${corrHeatBg(a.name === b.name ? null : r)}">${disp}</td>`;
    }).join('');
    return `<tr><td class="hm-row-label">${escapeHtml(a.name)}</td>${cells}</tr>`;
  }).join('');
  const matrixHtml = `<div class="table-scroll"><table class="ledger heatmap"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;

  const pairs = topCorrelationPairs(wd.correlationResult, 20);
  const strongPairs = pairs.filter(p => Math.abs(p.r) >= 0.3);
  const shown = strongPairs.length ? strongPairs : pairs.slice(0, 5);
  function bucket(r) { const a = Math.abs(r); if (a >= 0.5) return 'Strong'; if (a >= 0.3) return 'Moderate'; if (a >= 0.1) return 'Weak'; return 'Negligible'; }
  const listHtml = shown.length ? shown.map(p => `<li style="margin-bottom:9px;"><b>${escapeHtml(p.a)} ↔ ${escapeHtml(p.b)}</b> — r = ${p.r.toFixed(2)} <span class="pill ${Math.abs(p.r) >= 0.3 ? 'pill-strong' : 'pill-weak'}">${bucket(p.r)} · ${p.r > 0 ? 'positive' : 'negative'}</span></li>`).join('') : '<li>No pairs available.</li>';

  container.innerHTML = `<div class="tab-panel-head"><h2>Correlations</h2><p>Pearson correlation across numeric columns${truncated ? ` (showing the first 12 of ${totalNumeric})` : ''}.</p></div>
    ${panel('Correlation Matrix', matrixHtml)}
    <div class="section-divider"></div>
    ${panel('Notable Relationships', '<ul style="margin:0;padding-left:18px;color:var(--text-secondary);font-size:13px;line-height:1.7;">' + listHtml + '</ul>')}
    <div class="note-box" style="margin-top:16px;"><strong>Correlation is not causation.</strong> These figures show how strongly two numeric fields move together — not that one causes the other.</div>`;
}

function renderInsights(rows) {
  const container = document.getElementById('tab-insights');
  const wd = computeWorkingData(rows);
  const bc = state.businessContext;

  const findings = generateRuleBasedFindings(rows, wd);
  const findingsHtml = findings.length
    ? findings.map((f, i) => `<div class="finding-card"><div class="finding-num">FINDING ${String(i + 1).padStart(2, '0')}</div><div class="finding-title">${escapeHtml(f.title)}</div><div class="finding-body">${f.body}</div></div>`).join('')
    : '<p class="note-box">Not enough signal in the current filter to generate findings — try resetting filters.</p>';

  const routes = expectationRouting();
  const routeHtml = routes.length ? `<div class="note-box" style="margin-bottom:16px;"><strong>Based on what you told us you're looking for:</strong> see the ${routes.map(r => `<a href="#" class="route-link" data-tab="${r.tab}">${r.label}</a>`).join(', ')} tab${routes.length > 1 ? 's' : ''}.</div>` : '';

  const dupNote = wd.duplicateRowCount > 0 ? `<li>${wd.duplicateRowCount} fully duplicate row(s) detected — verify these are intentional.</li>` : '<li>No duplicate rows detected.</li>';
  const cardinalityWarnings = wd.profiles.filter(p => p.uniqueCount === 1).map(p => `<li><b>${escapeHtml(p.name)}</b> has only one distinct value across all records — it won't be useful for segmentation.</li>`).join('');
  const qualityHtml = `<ul style="margin:0;padding-left:18px;color:var(--text-secondary);font-size:13px;line-height:1.7;">
    <li>Every column in this file is fully populated — rows with blanks were rejected before this report was generated.</li>
    ${dupNote}${cardinalityWarnings}
  </ul>`;

  container.innerHTML = `<div class="tab-panel-head"><h2>Findings</h2><p>What the data shows for ${escapeHtml(domainLabel())} — plus an optional AI-written narrative.</p></div>
    ${routeHtml}${findingsHtml}
    <div class="section-divider"></div>
    ${panel('AI-Enhanced Narrative <span class="tag">optional</span>', `<p style="font-size:12.5px;color:var(--text-secondary);margin-bottom:12px;">Sends the statistical summary above (column names, types, KPI values, top correlations — never your raw file) to Claude to write a narrative tailored to what you said you're looking for.</p><button class="btn btn-primary btn-sm" id="btn-generate-ai" type="button">Generate AI Insights</button><div class="ai-result-box hidden" id="ai-insights-result"></div>`)}
    <div class="section-divider"></div>
    ${panel('Data Quality', qualityHtml)}`;

  const btn = document.getElementById('btn-generate-ai');
  if (btn) btn.onclick = generateAiInsights;
  const links = container.querySelectorAll ? container.querySelectorAll('.route-link') : [];
  links.forEach(a => a.addEventListener('click', e => { e.preventDefault(); switchTab(a.dataset.tab); }));
}

/* ============================================================
   COMPARISON TAB RENDERERS (2+ CSVs, matching schemas, as periods)
   ============================================================ */
function comparisonKpiCardHtml(c) {
  const rows = c.series.map((s, i) => {
    const delta = c.deltas[i];
    const deltaHtml = delta.fromPrev != null
      ? `<span class="delta-badge ${delta.fromPrev >= 0 ? 'delta-up' : 'delta-down'}">${delta.fromPrev >= 0 ? '\u25B2' : '\u25BC'} ${Math.abs(delta.fromPrev * 100).toFixed(1)}%</span>`
      : '<span class="delta-badge delta-baseline">baseline</span>';
    return `<div class="compare-kpi-row"><span class="compare-kpi-label">${escapeHtml(s.label)}</span><span class="compare-kpi-value">${fmtSmart(s.sum, c)}</span>${deltaHtml}</div>`;
  }).join('');
  return `<div class="panel compare-kpi-card"><div class="panel-title">${escapeHtml(c.name)}</div>${rows}</div>`;
}
function comparisonDeltaTableHtml(c) {
  const rows = c.series.map((s, i) => {
    const d = c.deltas[i];
    return `<tr><td>${escapeHtml(s.label)}</td><td class="num">${fmtSmart(s.sum, c)}</td><td class="num">${d.fromPrev != null ? (d.fromPrev >= 0 ? '+' : '') + (d.fromPrev * 100).toFixed(1) + '%' : '\u2014'}</td></tr>`;
  }).join('');
  return `<div class="table-scroll"><table class="ledger"><thead><tr><th>Period</th><th class="num">Value</th><th class="num">vs Previous</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function periodChipsHtml(periods) {
  return periods.map((p, i) => `<span class="period-chip"><span class="period-chip-dot" style="background:${PBI_PALETTE[i % PBI_PALETTE.length]};"></span>${escapeHtml(p.label)} <span class="small-n">(${fmtInt(p.rawRows.length)} records)</span></span>`).join('');
}
function renderCompareOverview(periods, comparison) {
  const container = document.getElementById('tab-compare-overview');
  const bc = state.businessContext;
  const contextPanel = panel('Report Context', `<div class="grid grid-3">
      <div><div class="kpi-label">Business Domain</div><div style="font-size:13px;font-weight:600;">${escapeHtml(domainLabel())}</div></div>
      <div><div class="kpi-label">About These Files</div><div class="wrap-cell" style="font-size:12.5px;color:var(--text-secondary);">${escapeHtml(bc.description)}</div></div>
      <div><div class="kpi-label">What You're Looking For</div><div class="wrap-cell" style="font-size:12.5px;color:var(--text-secondary);">${escapeHtml(bc.expectations)}</div></div>
    </div>`);
  const kpiRow = comparison.headlineComparisons.length
    ? `<div class="grid grid-3" style="margin-top:12px;">${comparison.headlineComparisons.slice(0, 6).map(comparisonKpiCardHtml).join('')}</div>`
    : `<div class="note-box" style="margin-top:12px;">No shared numeric KPI columns (revenue, quantity, etc.) were detected across all periods.</div>`;

  container.innerHTML = `<div class="tab-panel-head"><h2>Comparison Overview</h2><p>Comparing ${periods.length} periods for ${escapeHtml(domainLabel())}.</p></div>
    ${contextPanel}
    <div class="period-chips">${periodChipsHtml(periods)}</div>
    <div class="section-divider"></div>
    ${panel('Records Per Period', '<div class="chart-canvas-wrap short"><canvas id="chart-compare-volume"></canvas></div>')}
    ${kpiRow}`;

  barChart('chart-compare-volume', periods.map(p => p.label), periods.map(p => p.rawRows.length), { colors: pbiColors(periods.length) });
}
function renderCompareTrends(periods, comparison) {
  const container = document.getElementById('tab-compare-trends');
  const metrics = comparison.numericComparisons.slice(0, 8);
  if (!metrics.length) {
    container.innerHTML = `<div class="tab-panel-head"><h2>Trends Across Periods</h2></div><div class="note-box">No shared numeric columns were found across all periods to chart.</div>`;
    return;
  }
  const panels = metrics.map((c, i) => panel(escapeHtml(c.name), `<div class="chart-canvas-wrap short"><canvas id="chart-compare-trend-${i}"></canvas></div>` + comparisonDeltaTableHtml(c)));
  container.innerHTML = `<div class="tab-panel-head"><h2>Trends Across Periods</h2><p>How each shared metric moved across ${periods.length} periods. Arrows are directional only — whether up or down is "good" depends on the metric.</p></div>
    <div class="grid grid-2">${panels.join('')}</div>`;
  metrics.forEach((c, i) => lineChart(`chart-compare-trend-${i}`, c.series.map(s => s.label), c.series.map(s => Math.round(s.sum * 100) / 100)));
}
function renderCompareCategories(periods, comparison) {
  const container = document.getElementById('tab-compare-categories');
  const cats = comparison.categoricalComparisons;
  if (!cats.length) {
    container.innerHTML = `<div class="tab-panel-head"><h2>Category Shifts</h2></div><div class="note-box">No shared categorical columns were found across all periods.</div>`;
    return;
  }
  const panels = cats.map(c => {
    const allValues = Array.from(new Set(c.series.flatMap(s => s.top.map(t => t.value))));
    const head = '<tr><th>Value</th>' + c.series.map(s => `<th class="num">${escapeHtml(s.label)}</th>`).join('') + '</tr>';
    const body = allValues.slice(0, 8).map(val => {
      const cells = c.series.map(s => { const entry = s.top.find(t => t.value === val); return `<td class="num">${entry ? fmtPct(entry.pct, 1) : '\u2014'}</td>`; }).join('');
      return `<tr><td class="wrap-cell">${escapeHtml(String(val))}</td>${cells}</tr>`;
    }).join('');
    return panel(escapeHtml(c.name) + ' <span class="tag">% of records</span>', `<div class="table-scroll"><table class="ledger"><thead>${head}</thead><tbody>${body}</tbody></table></div>`);
  });
  container.innerHTML = `<div class="tab-panel-head"><h2>Category Shifts</h2><p>Each value's share of records, period over period.</p></div>
    <div class="grid grid-2">${panels.join('')}</div>`;
}
function buildCompareAiSummaryPayload(periods, comparison) {
  const metricPool = comparison.headlineComparisons.length ? comparison.headlineComparisons : comparison.numericComparisons;
  return {
    periods: periods.map(p => ({ label: p.label, recordCount: p.rawRows.length })),
    metrics: metricPool.slice(0, 10).map(c => ({ name: c.name, type: TYPE_LABELS[c.valueType] || c.valueType, series: c.series.map(s => ({ label: s.label, sum: round2(s.sum), mean: round2(s.mean) })) })),
    categoryShifts: comparison.categoricalComparisons.slice(0, 6).map(c => ({ name: c.name, series: c.series.map(s => ({ label: s.label, top: s.top.slice(0, 5).map(t => ({ value: t.value, pct: Math.round(t.pct * 1000) / 10 })) })) })),
  };
}
async function generateCompareAiInsights() {
  const btn = document.getElementById('btn-generate-ai-compare');
  const resultEl = document.getElementById('ai-insights-result-compare');
  if (!btn || !resultEl) return;
  btn.disabled = true; btn.textContent = 'Generating…';
  resultEl.classList.remove('hidden');
  resultEl.innerHTML = '<div class="note-box">Contacting the AI service for a period-over-period analysis…</div>';
  try {
    const summary = buildCompareAiSummaryPayload(state.periods, state.comparisonData);
    const text = await callAiInsightsProxy(summary, state.businessContext, 'compare');
    resultEl.innerHTML = simpleMarkdownToHtml(text);
    btn.textContent = 'Regenerate AI Insights';
  } catch (e) {
    resultEl.innerHTML = `<div class="note-box warn"><strong>AI insights are unavailable right now.</strong> This feature calls the <code>/api/ai-insights</code> server function, which needs to be deployed with a valid Anthropic API key (see the project README). The rule-based findings above already reflect the full comparison.</div>`;
    btn.textContent = 'Try Again';
  } finally {
    btn.disabled = false;
  }
}
function renderCompareFindings(periods, comparison) {
  const container = document.getElementById('tab-compare-insights');
  const findings = generateComparisonFindings(periods, comparison);
  const findingsHtml = findings.length
    ? findings.map((f, i) => `<div class="finding-card"><div class="finding-num">FINDING ${String(i + 1).padStart(2, '0')}</div><div class="finding-title">${escapeHtml(f.title)}</div><div class="finding-body">${escapeHtml(f.body || '')}</div></div>`).join('')
    : '<p class="note-box">No shifts of 5% or more were detected between these periods.</p>';

  container.innerHTML = `<div class="tab-panel-head"><h2>Findings</h2><p>What changed between periods, for ${escapeHtml(domainLabel())} — plus an optional AI-written narrative.</p></div>
    ${findingsHtml}
    <div class="section-divider"></div>
    ${panel('AI-Enhanced Narrative <span class="tag">optional</span>', `<p style="font-size:12.5px;color:var(--text-secondary);margin-bottom:12px;">Sends the period-over-period summary above (labels, KPI values per period, category shares — never your raw files) to Claude to write a narrative tailored to what you said you're looking for.</p><button class="btn btn-primary btn-sm" id="btn-generate-ai-compare" type="button">Generate AI Insights</button><div class="ai-result-box hidden" id="ai-insights-result-compare"></div>`)}
    <div class="section-divider"></div>
    ${panel('Data Quality', `<ul style="margin:0;padding-left:18px;color:var(--text-secondary);font-size:13px;line-height:1.7;"><li>Every period file passed the same blank-cell rejection as single-file analysis — nothing here was silently patched.</li><li>All ${periods.length} periods share the exact same set of columns, verified before comparison began.</li></ul>`)}`;

  const btn = document.getElementById('btn-generate-ai-compare');
  if (btn) btn.onclick = generateCompareAiInsights;
}

/* ============================================================
   SCREEN TRANSITIONS
   ============================================================ */
function showContextScreen() {
  document.getElementById('screen-dashboard').classList.add('hidden');
  document.getElementById('screen-upload').classList.add('hidden');
  document.getElementById('screen-blank-error').classList.add('hidden');
  document.getElementById('sidebar').classList.add('hidden');
  document.getElementById('screen-context').classList.remove('hidden');
}
function showUploadScreenOnly() {
  document.getElementById('screen-dashboard').classList.add('hidden');
  document.getElementById('screen-blank-error').classList.add('hidden');
  document.getElementById('screen-context').classList.add('hidden');
  document.getElementById('screen-upload').classList.remove('hidden');
  document.getElementById('sidebar').classList.add('hidden');
  const singleEl = document.getElementById('upload-single-mode');
  const compareEl = document.getElementById('upload-compare-mode');
  const shellEl = document.getElementById('upload-shell');
  if (singleEl) singleEl.classList.toggle('hidden', state.mode === 'compare');
  if (compareEl) compareEl.classList.toggle('hidden', state.mode !== 'compare');
  if (shellEl) shellEl.classList.toggle('upload-shell-wide', state.mode === 'compare');
  if (state.mode === 'compare') { ensureMinimumPeriodSlots(); renderPeriodSlotsContainer(); updateCompareButtonState(); }
  updateUploadRecap();
}
let capturedSingleNavHtml = null;
const COMPARE_NAV_HTML = `
  <button class="tab-btn active" data-tab="compare-overview"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>Overview</button>
  <button class="tab-btn" data-tab="compare-trends"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 16l5-6 4 3 7-9"/><path d="M15 4h5v5"/></svg>Trends</button>
  <button class="tab-btn" data-tab="compare-categories"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="12" width="4" height="8"/><rect x="10" y="7" width="4" height="13"/><rect x="16" y="3" width="4" height="17"/></svg>Categories</button>
  <button class="tab-btn" data-tab="compare-insights"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18h6M10 21h4"/><path d="M12 3a6.5 6.5 0 00-3.8 11.8c.5.4.8 1 .8 1.7v.5h6v-.5c0-.7.3-1.3.8-1.7A6.5 6.5 0 0012 3z"/></svg>Findings</button>`;
function renderSidebarNav() {
  const nav = document.getElementById('tab-nav');
  if (!nav) return;
  if (capturedSingleNavHtml === null) capturedSingleNavHtml = nav.innerHTML;
  nav.innerHTML = state.mode === 'compare' ? COMPARE_NAV_HTML : capturedSingleNavHtml;
}
function showDashboard() {
  document.getElementById('screen-context').classList.add('hidden');
  document.getElementById('screen-upload').classList.add('hidden');
  document.getElementById('screen-blank-error').classList.add('hidden');
  document.getElementById('screen-dashboard').classList.remove('hidden');
  document.getElementById('sidebar').classList.remove('hidden');
  renderSidebarNav();
}
function updateUploadRecap() {
  const el = document.getElementById('upload-recap');
  if (!el) return;
  el.innerHTML = state.mode === 'compare'
    ? `Comparing periods for <b>${escapeHtml(domainLabel())}</b> — "${escapeHtml(state.businessContext.description)}"`
    : `Analyzing for <b>${escapeHtml(domainLabel())}</b> — "${escapeHtml(state.businessContext.description)}"`;
}

/* ============================================================
   BUSINESS CONTEXT FORM
   ============================================================ */
function toggleDomainOther() {
  const domainSel = document.getElementById('ctx-domain');
  const wrap = document.getElementById('ctx-domain-other-wrap');
  if (domainSel && wrap) wrap.classList.toggle('hidden', domainSel.value !== 'Other');
}
function updateContextCopyForMode() {
  document.querySelectorAll('.mode-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === state.mode));
  const label = document.getElementById('ctx-description-label');
  const field = document.getElementById('ctx-description');
  if (state.mode === 'compare') {
    if (label) label.textContent = 'What are these files about?';
    if (field) field.placeholder = 'e.g. Monthly sales exports we want to compare across the year';
  } else {
    if (label) label.textContent = 'What is this file about?';
    if (field) field.placeholder = 'e.g. Monthly sales transactions from our online store';
  }
}
function handleModeChange(newMode) {
  if (newMode === state.mode) return;
  state.mode = newMode;
  state.periods = []; state.comparisonData = null;
  state.rawRows = []; state.columns = []; state.fullProfiles = [];
  updateContextCopyForMode();
}
function validateContextForm() {
  const description = (document.getElementById('ctx-description').value || '').trim();
  const domain = document.getElementById('ctx-domain').value;
  const domainOther = (document.getElementById('ctx-domain-other').value || '').trim();
  const expectations = (document.getElementById('ctx-expectations').value || '').trim();
  const valid = description.length > 0 && !!domain && (domain !== 'Other' || domainOther.length > 0) && expectations.length > 0;
  const btn = document.getElementById('btn-continue-context');
  if (btn) btn.disabled = !valid;
  return valid;
}
function handleContinueContext() {
  if (!validateContextForm()) return;
  state.businessContext = {
    description: document.getElementById('ctx-description').value.trim(),
    domain: document.getElementById('ctx-domain').value,
    domainOther: document.getElementById('ctx-domain-other').value.trim(),
    expectations: document.getElementById('ctx-expectations').value.trim(),
  };
  showUploadScreenOnly();
}
function editContext() {
  const bc = state.businessContext;
  document.getElementById('ctx-description').value = bc.description || '';
  document.getElementById('ctx-domain').value = bc.domain || '';
  document.getElementById('ctx-domain-other').value = bc.domainOther || '';
  document.getElementById('ctx-expectations').value = bc.expectations || '';
  toggleDomainOther();
  validateContextForm();
  updateContextCopyForMode();
  showContextScreen();
}
function resetContextForm() {
  document.getElementById('ctx-description').value = '';
  document.getElementById('ctx-domain').value = '';
  document.getElementById('ctx-domain-other').value = '';
  document.getElementById('ctx-expectations').value = '';
  toggleDomainOther();
  validateContextForm();
  updateContextCopyForMode();
}

/* ============================================================
   COMPARE MODE — multi-file period slots
   ============================================================ */
function ensureMinimumPeriodSlots() {
  while (state.periods.length < 2) state.periods.push(null);
}
function addPeriodSlot() {
  if (state.periods.length >= MAX_COMPARE_PERIODS) return;
  state.periods.push(null);
  renderPeriodSlotsContainer();
}
function removePeriodSlot(index) {
  if (state.periods.length <= 2) return; // keep a minimum of 2 slots
  state.periods.splice(index, 1);
  renderPeriodSlotsContainer();
  updateCompareButtonState();
}
function getReferenceColumns(excludeIndex) {
  for (let i = 0; i < state.periods.length; i++) {
    if (i === excludeIndex) continue;
    const p = state.periods[i];
    if (p && p.status === 'ready') return p.columns;
  }
  return null;
}
function periodErrorDetailHtml(blankResult) {
  const { byColumn, log } = blankResult;
  const summary = Object.entries(byColumn).map(([col, info]) => `${escapeHtml(col)} (${info.count})`).join(', ');
  const logLines = log.slice(0, 20).map(e => `<div class="log-line"><span class="log-row">Row ${e.row}</span><span class="log-col">"${escapeHtml(e.column)}"</span><span class="log-msg">is blank</span></div>`).join('');
  return `<div class="period-error-detail">Blank cells in: ${summary}<div class="log-panel log-panel-sm">${logLines}${log.length > 20 ? `<div class="log-line log-msg">…and ${log.length - 20} more</div>` : ''}</div></div>`;
}
function schemaErrorDetailHtml(expected, actual) {
  const diff = columnSetDiff(expected, actual);
  const parts = [];
  if (diff.onlyInA.length) parts.push(`The first period has "${diff.onlyInA.join('", "')}" — this file doesn't.`);
  if (diff.onlyInB.length) parts.push(`This file has "${diff.onlyInB.join('", "')}" — the first period doesn't.`);
  return `<div class="period-error-detail">${parts.map(p => escapeHtml(p)).join('<br>')}</div>`;
}
function renderPeriodSlotHtml(index) {
  const slot = state.periods[index];
  const num = index + 1;
  let bodyHtml;
  if (!slot) {
    bodyHtml = `<label class="period-dropzone" for="period-file-${index}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 16V4M12 4L7 9M12 4l5 5"/><path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>
        <span>Choose CSV file</span>
      </label>
      <input type="file" id="period-file-${index}" class="period-file-input" data-slot-index="${index}" accept=".csv,text/csv">`;
  } else if (slot.status === 'loading') {
    bodyHtml = `<div class="period-status period-status-loading"><span class="spinner-sm"></span>Reading file…</div>`;
  } else if (slot.status === 'error') {
    bodyHtml = `<div class="period-status period-status-error">
        <strong>${escapeHtml(slot.message)}</strong>
        ${slot.detailHtml || ''}
        <label class="link-back period-retry" for="period-file-${index}">Choose a different file</label>
        <input type="file" id="period-file-${index}" class="period-file-input" data-slot-index="${index}" accept=".csv,text/csv">
      </div>`;
  } else {
    bodyHtml = `<div class="period-status period-status-ready">
        <div class="period-ready-row"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20 6L9 17l-5-5"/></svg><span class="wrap-cell">${escapeHtml(slot.meta.fileName)}</span></div>
        <div class="small-n">${fmtInt(slot.rawRows.length)} rows · ${fmtInt(slot.columns.length)} columns</div>
        <input type="text" class="period-label-input" data-slot-index="${index}" value="${escapeHtml(slot.label)}" placeholder="Label this period">
      </div>`;
  }
  return `<div class="period-slot" data-slot-index="${index}">
    <div class="period-slot-header">
      <span class="period-slot-num">Period ${num}</span>
      ${state.periods.length > 2 ? `<button class="period-slot-remove" data-slot-index="${index}" type="button" aria-label="Remove period ${num}">\u2715</button>` : ''}
    </div>
    <div class="period-slot-body">${bodyHtml}</div>
  </div>`;
}
function renderPeriodSlotsContainer() {
  const container = document.getElementById('period-slots');
  if (!container) return;
  container.innerHTML = state.periods.map((_, i) => renderPeriodSlotHtml(i)).join('');
  container.querySelectorAll('.period-file-input').forEach(input => {
    input.addEventListener('change', e => { const f = e.target.files[0]; if (f) handlePeriodFile(Number(input.dataset.slotIndex), f); });
  });
  container.querySelectorAll('.period-slot-remove').forEach(btn => {
    btn.addEventListener('click', () => removePeriodSlot(Number(btn.dataset.slotIndex)));
  });
  container.querySelectorAll('.period-label-input').forEach(input => {
    input.addEventListener('input', () => { const idx = Number(input.dataset.slotIndex); if (state.periods[idx]) state.periods[idx].label = input.value; });
  });
  const addBtn = document.getElementById('btn-add-period');
  if (addBtn) addBtn.classList.toggle('hidden', state.periods.length >= MAX_COMPARE_PERIODS);
}
function updateCompareButtonState() {
  const btn = document.getElementById('btn-compare-submit');
  if (!btn) return;
  const readyCount = readyPeriods().length;
  btn.disabled = readyCount < 2;
  btn.textContent = readyCount >= 2 ? `Compare ${readyCount} Periods \u2192` : `Add at least ${2 - readyCount} more period${2 - readyCount > 1 ? 's' : ''}`;
}
async function handlePeriodFile(index, file) {
  if (!file) return;
  state.periods[index] = { status: 'loading' };
  renderPeriodSlotsContainer();
  if (!/\.csv$/i.test(file.name) && file.type && file.type !== 'text/csv' && file.type !== 'application/vnd.ms-excel') {
    state.periods[index] = { status: 'error', message: 'Unexpected file type — please upload a .csv file.' };
    renderPeriodSlotsContainer(); updateCompareButtonState(); return;
  }
  try {
    const results = await parseCsvFile(file);
    const headers = (results.meta && results.meta.fields) || [];
    if (!results.data || results.data.length === 0) {
      state.periods[index] = { status: 'error', message: 'No data rows found in this file.' };
      renderPeriodSlotsContainer(); updateCompareButtonState(); return;
    }
    if (headers.length === 0) {
      state.periods[index] = { status: 'error', message: 'No header row detected in this file.' };
      renderPeriodSlotsContainer(); updateCompareButtonState(); return;
    }
    const cleanRows = normalizeRawRows(results.data, headers);
    const blankResult = findBlankColumns(cleanRows, headers);
    if (blankResult.log.length > 0) {
      state.periods[index] = { status: 'error', message: `${Object.keys(blankResult.byColumn).length} column(s) contain blank values.`, detailHtml: periodErrorDetailHtml(blankResult) };
      renderPeriodSlotsContainer(); updateCompareButtonState(); return;
    }
    const referenceColumns = getReferenceColumns(index);
    if (referenceColumns && !sameColumnSet(referenceColumns, headers)) {
      state.periods[index] = { status: 'error', message: "This file's columns don't match the other period(s).", detailHtml: schemaErrorDetailHtml(referenceColumns, headers) };
      renderPeriodSlotsContainer(); updateCompareButtonState(); return;
    }
    const full = buildDataset(cleanRows, headers);
    const dateP = full.dateColumn ? full.profiles.find(p => p.name === full.dateColumn) : null;
    const label = deriveAutoLabel(dateP ? dateP.date : null, file.name);
    state.periods[index] = {
      status: 'ready', label, rawRows: cleanRows, columns: headers, profiles: full.profiles,
      headlineKpiNames: full.headlineKpis.map(p => p.name), dateColumn: full.dateColumn,
      meta: { fileName: file.name, uploadedAt: new Date().toISOString(), rowCount: cleanRows.length },
    };
    renderPeriodSlotsContainer(); updateCompareButtonState();
  } catch (err) {
    state.periods[index] = { status: 'error', message: (err && err.message) || 'Could not read this file.' };
    renderPeriodSlotsContainer(); updateCompareButtonState();
  }
}
async function handleCompareSubmit() {
  const periods = readyPeriods();
  if (periods.length < 2) return;
  showLoading('Building your comparison…');
  state.comparisonData = buildPeriodComparison(periods);
  state.renderedTabs.clear();
  Object.keys(state.charts).forEach(destroyChart);
  document.getElementById('dataset-filename').textContent = `${periods.length} periods compared`;
  document.getElementById('dataset-count').textContent = periods.map(p => p.label).join(' \u00b7 ');
  await saveCompareToStorage(periods);
  hideLoading();
  showDashboard();
  state.activeTab = 'compare-overview';
  switchTab('compare-overview');
}

/* ============================================================
   BLANK-DATA GATE
   ============================================================ */
function showBlankDataError(blankResult, totalRows) {
  const { byColumn, log } = blankResult;
  const rowsHtml = Object.entries(byColumn).map(([col, info]) =>
    `<tr><td>${escapeHtml(col)}</td><td class="num">${fmtInt(info.count)}</td><td class="num">${fmtPct(info.count / totalRows, 1)}</td><td class="wrap-cell">${info.exampleRows.join(', ')}${info.count > info.exampleRows.length ? ', …' : ''}</td></tr>`
  ).join('');
  document.getElementById('blank-error-table-body').innerHTML = rowsHtml;
  document.getElementById('blank-error-count').textContent = Object.keys(byColumn).length;

  const LOG_CAP = 300;
  const shown = log.slice(0, LOG_CAP);
  const logHtml = shown.map(e => `<div class="log-line"><span class="log-row">Row ${e.row}</span><span class="log-col">"${escapeHtml(e.column)}"</span><span class="log-msg">is blank</span></div>`).join('');
  const logEl = document.getElementById('blank-error-log');
  logEl.innerHTML = logHtml || '<div class="log-line">No entries.</div>';
  document.getElementById('blank-error-log-total').textContent = fmtInt(log.length);
  document.getElementById('blank-error-log-note').classList.toggle('hidden', log.length <= LOG_CAP);
  if (log.length > LOG_CAP) document.getElementById('blank-error-log-remaining').textContent = fmtInt(log.length - LOG_CAP);

  document.getElementById('screen-upload').classList.add('hidden');
  document.getElementById('screen-blank-error').classList.remove('hidden');
}
function retryUpload() {
  document.getElementById('screen-blank-error').classList.add('hidden');
  document.getElementById('screen-upload').classList.remove('hidden');
  document.getElementById('file-input').value = '';
}

/* ============================================================
   PERSISTENT STORAGE (browser localStorage — works on any host)
   ============================================================ */
function storageAvailable() {
  try {
    const t = '__storage_test__';
    localStorage.setItem(t, '1');
    localStorage.removeItem(t);
    return true;
  } catch (e) { return false; }
}
async function loadFromStorage() {
  if (!storageAvailable()) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
async function saveToStorage(rawRows, columns, meta) {
  if (!storageAvailable()) return false;
  try {
    const payload = JSON.stringify({ mode: 'single', rawRows, columns, meta, businessContext: state.businessContext });
    if (payload.length > 4.8 * 1024 * 1024) { console.warn('Dataset too large to persist for next session (over ~5MB browser storage limit).'); return false; }
    localStorage.setItem(STORAGE_KEY, payload);
    return true;
  } catch (e) { console.warn('Could not save dataset to storage', e); return false; }
}
async function saveCompareToStorage(periods) {
  if (!storageAvailable()) return false;
  try {
    const payload = JSON.stringify({
      mode: 'compare',
      periods: periods.map(p => ({ label: p.label, rawRows: p.rawRows, columns: p.columns, meta: p.meta })),
      businessContext: state.businessContext,
    });
    if (payload.length > 4.8 * 1024 * 1024) { console.warn('Comparison data too large to persist for next session (over ~5MB browser storage limit).'); return false; }
    localStorage.setItem(STORAGE_KEY, payload);
    return true;
  } catch (e) { console.warn('Could not save comparison to storage', e); return false; }
}
async function clearStorageData() { try { if (storageAvailable()) localStorage.removeItem(STORAGE_KEY); } catch (e) { /* nothing to clear */ } }

/* ============================================================
   UPLOAD / PARSE
   ============================================================ */
function makeHeaderTransformer() {
  const seen = new Map();
  return function (rawHeader) {
    let h = String(rawHeader).replace(/^\uFEFF/, '').trim();
    if (h === '') h = 'Column';
    const count = seen.get(h) || 0;
    seen.set(h, count + 1);
    return count === 0 ? h : `${h}_${count + 1}`;
  };
}
function normalizeRawRows(data, headers) {
  return data.map(row => {
    const clean = {};
    headers.forEach(h => { const v = row[h]; clean[h] = typeof v === 'string' ? v.trim() : v; });
    return clean;
  });
}
function parseCsvFile(file) {
  return new Promise((resolve, reject) => {
    if (!papaAvailable()) { reject(new Error('The CSV parser failed to load. Check your connection and reload the page.')); return; }
    Papa.parse(file, { header: true, skipEmptyLines: true, transformHeader: makeHeaderTransformer(), complete: resolve, error: reject });
  });
}
function showUploadError(title, detail) {
  const el = document.getElementById('upload-error');
  el.innerHTML = `<strong>${escapeHtml(title)}</strong>${escapeHtml(detail)}`;
  el.classList.remove('hidden');
}
function clearUploadError() { document.getElementById('upload-error').classList.add('hidden'); }
function setUploadStatus(text) { document.getElementById('upload-status').textContent = text; }
function showLoading(text) { document.getElementById('loading-text').textContent = text; document.getElementById('loading-overlay').classList.add('show'); }
function hideLoading() { document.getElementById('loading-overlay').classList.remove('show'); }

async function loadDataset(rawRows, columns, meta) {
  state.rawRows = rawRows;
  state.columns = columns;
  state.meta = meta;
  const full = buildDataset(rawRows, columns);
  state.fullProfiles = full.profiles;
  state.headlineKpiNames = full.headlineKpis.map(p => p.name);
  state.filterableColumns = full.filterableColumns;
  state.dateColumn = full.dateColumn;
  state.duplicateRowCount = full.duplicateRowCount;
  state.renderedTabs.clear();
  Object.keys(state.charts).forEach(destroyChart);
  populateFilterOptions();
  document.getElementById('dataset-filename').textContent = meta.fileName || 'Saved report';
  document.getElementById('dataset-count').textContent = fmtInt(meta.rowCount) + ' records · ' + fmtInt(columns.length) + ' columns' + (meta.uploadedAt ? ' · loaded ' + new Date(meta.uploadedAt).toLocaleDateString() : '');
  switchTab('overview');
}
async function handleFile(file) {
  clearUploadError();
  if (!file) return;
  if (!/\.csv$/i.test(file.name) && file.type && file.type !== 'text/csv' && file.type !== 'application/vnd.ms-excel') {
    showUploadError('Unexpected file type.', ' Please upload a .csv file.'); return;
  }
  showLoading('Reading your file…');
  setUploadStatus('Parsing ' + file.name + '…');
  try {
    const results = await parseCsvFile(file);
    const headers = (results.meta && results.meta.fields) || [];
    if (!results.data || results.data.length === 0) {
      hideLoading(); setUploadStatus('');
      showUploadError('No rows found.', ' The file parsed but contained no data rows.');
      return;
    }
    if (headers.length === 0) {
      hideLoading(); setUploadStatus('');
      showUploadError('No columns detected.', ' Please check that the file has a header row.');
      return;
    }
    const cleanRows = normalizeRawRows(results.data, headers);
    showLoading('Checking for blank cells…');
    const blankResult = findBlankColumns(cleanRows, headers);
    if (blankResult.log.length > 0) {
      hideLoading(); setUploadStatus('');
      showBlankDataError(blankResult, cleanRows.length);
      return;
    }
    const meta = { fileName: file.name, uploadedAt: new Date().toISOString(), rowCount: cleanRows.length, columns: headers };
    showLoading('Profiling columns and building your report…');
    await loadDataset(cleanRows, headers, meta);
    await saveToStorage(cleanRows, headers, meta);
    setUploadStatus(''); hideLoading(); showDashboard();
  } catch (err) {
    hideLoading(); setUploadStatus('');
    showUploadError('Could not read this file.', ' ' + ((err && err.message) || 'Please check the file is a valid CSV and try again.'));
  }
}

/* ============================================================
   GENERIC FILTERS (dynamic, based on the file's own columns)
   ============================================================ */
function populateFilterOptions() {
  const container = document.getElementById('filters-row-dynamic');
  if (!container) return;
  container.innerHTML = '';
  state.filters = {};
  state.filterableColumns.forEach(p => {
    state.filters[p.name] = 'All';
    const field = document.createElement('div');
    field.className = 'filter-field';
    const options = p.categorical.top.map(t => `<option value="${escapeHtml(String(t.value))}">${escapeHtml(String(t.value))}</option>`).join('');
    field.innerHTML = `<label>${escapeHtml(p.name)}</label><select data-filter-col="${escapeHtml(p.name)}"><option value="All">All</option>${options}</select>`;
    container.appendChild(field);
  });
  const selects = container.querySelectorAll ? container.querySelectorAll('select') : [];
  selects.forEach(sel => sel.addEventListener('change', e => { state.filters[sel.dataset.filterCol] = e.target.value; applyFilters(); }));
  updateFilterNote();
}
function getFilteredRows() {
  return state.rawRows.filter(r => {
    for (const col in state.filters) {
      const val = state.filters[col];
      if (val !== 'All' && String(r[col]).trim() !== val) return false;
    }
    return true;
  });
}
function updateFilterNote() {
  const active = Object.values(state.filters).some(v => v !== 'All');
  const el = document.getElementById('filter-note');
  if (el) el.textContent = active ? `Showing ${getFilteredRows().length.toLocaleString()} of ${state.rawRows.length.toLocaleString()} records` : '';
}
function applyFilters() { state.renderedTabs.clear(); updateFilterNote(); renderActiveTab(); }

/* ============================================================
   TAB SWITCHING
   ============================================================ */
const SINGLE_TAB_RENDERERS = {
  overview: renderOverview, dataprofile: renderDataProfile, trends: renderTrends,
  categories: renderCategories, correlations: renderCorrelationsTab, insights: renderInsights,
};
const COMPARE_TAB_RENDERERS = {
  'compare-overview': renderCompareOverview, 'compare-trends': renderCompareTrends,
  'compare-categories': renderCompareCategories, 'compare-insights': renderCompareFindings,
};
function renderActiveTab() {
  const tab = state.activeTab;
  if (state.renderedTabs.has(tab)) return;
  if (state.mode === 'compare') {
    const fn = COMPARE_TAB_RENDERERS[tab];
    if (!fn) return;
    fn(readyPeriods(), state.comparisonData);
  } else {
    const fn = SINGLE_TAB_RENDERERS[tab];
    if (!fn) return;
    fn(getFilteredRows());
  }
  state.renderedTabs.add(tab);
}
function switchTab(tabId) {
  state.activeTab = tabId;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tabId));
  renderActiveTab();
}
function readyPeriods() { return state.periods.filter(p => p && p.status === 'ready'); }

/* ============================================================
   EXPORT DATA PROFILE
   ============================================================ */
function exportProfileSummary() {
  if (!state.fullProfiles.length) return;
  const cols = ['Column', 'Type', 'Role', 'Count', 'Unique', 'Sum', 'Mean', 'Median', 'Min', 'Max', 'TopValue', 'TopValuePct'];
  const escapeCsv = v => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [cols.join(',')];
  state.fullProfiles.forEach(p => {
    const row = [p.name, TYPE_LABELS[p.valueType] || p.valueType, ROLE_LABELS[p.role] || p.role, p.count, p.uniqueCount,
      p.numeric ? round2(p.numeric.sum) : '', p.numeric ? round2(p.numeric.mean) : '', p.numeric ? round2(p.numeric.median) : '',
      p.numeric ? round2(p.numeric.min) : '', p.numeric ? round2(p.numeric.max) : '',
      p.categorical ? p.categorical.top[0].value : '', p.categorical ? Math.round(p.categorical.top[0].pct * 1000) / 10 : ''];
    lines.push(row.map(escapeCsv).join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = (state.meta.fileName || 'data').replace(/\.csv$/i, '') + '_profile.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ============================================================
   EVENTS + INIT
   ============================================================ */
async function handleClearData() {
  await clearStorageData();
  state.rawRows = []; state.columns = []; state.fullProfiles = []; state.headlineKpiNames = [];
  state.filterableColumns = []; state.dateColumn = null; state.duplicateRowCount = 0; state.renderedTabs.clear();
  state.periods = []; state.comparisonData = null; state.mode = 'single';
  state.businessContext = { description: '', domain: '', domainOther: '', expectations: '' };
  Object.keys(state.charts).forEach(destroyChart);
  document.getElementById('file-input').value = '';
  setUploadStatus(''); clearUploadError();
  resetContextForm();
  showContextScreen();
}
function handleReplaceData() { editContext(); }
function wireEvents() {
  const dz = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });
  ['dragenter', 'dragover'].forEach(evt => dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach(evt => dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.remove('drag-over'); }));
  dz.addEventListener('drop', e => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) handleFile(f); });

  document.getElementById('tab-nav').addEventListener('click', e => { const btn = e.target.closest('.tab-btn'); if (btn) switchTab(btn.dataset.tab); });

  document.querySelectorAll('.mode-toggle-btn').forEach(btn => btn.addEventListener('click', () => handleModeChange(btn.dataset.mode)));
  document.getElementById('btn-continue-context').addEventListener('click', handleContinueContext);
  ['ctx-description', 'ctx-domain-other', 'ctx-expectations'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('input', validateContextForm); });
  document.getElementById('ctx-domain').addEventListener('change', () => { toggleDomainOther(); validateContextForm(); });
  document.getElementById('btn-edit-context').addEventListener('click', editContext);
  document.getElementById('btn-retry-upload').addEventListener('click', retryUpload);
  document.getElementById('btn-add-period').addEventListener('click', addPeriodSlot);
  document.getElementById('btn-compare-submit').addEventListener('click', handleCompareSubmit);

  document.getElementById('btn-reset-filters').addEventListener('click', () => {
    Object.keys(state.filters).forEach(k => { state.filters[k] = 'All'; });
    const selects = document.querySelectorAll('[data-filter-col]');
    selects.forEach(sel => { sel.value = 'All'; });
    applyFilters();
  });
  document.getElementById('btn-export').addEventListener('click', exportProfileSummary);
  document.getElementById('btn-replace').addEventListener('click', handleReplaceData);
  document.getElementById('btn-clear').addEventListener('click', handleClearData);
}
async function init() {
  setChartDefaults();
  wireEvents();
  toggleDomainOther();
  validateContextForm();
  updateContextCopyForMode();
  showLoading('Checking for a saved report…');
  const stored = await loadFromStorage();
  if (stored && stored.mode === 'compare' && Array.isArray(stored.periods) && stored.periods.length >= 2) {
    state.mode = 'compare';
    state.businessContext = stored.businessContext || state.businessContext;
    const restored = stored.periods.map(p => {
      const full = buildDataset(p.rawRows, p.columns);
      return { status: 'ready', label: p.label, rawRows: p.rawRows, columns: p.columns, profiles: full.profiles, headlineKpiNames: full.headlineKpis.map(x => x.name), dateColumn: full.dateColumn, meta: p.meta };
    });
    state.periods = restored;
    state.comparisonData = buildPeriodComparison(restored);
    document.getElementById('dataset-filename').textContent = `${restored.length} periods compared`;
    document.getElementById('dataset-count').textContent = restored.map(p => p.label).join(' \u00b7 ');
    hideLoading();
    showDashboard();
    state.activeTab = 'compare-overview';
    switchTab('compare-overview');
  } else if (stored && stored.rawRows && stored.rawRows.length && stored.columns) {
    state.mode = 'single';
    state.businessContext = stored.businessContext || state.businessContext;
    await loadDataset(stored.rawRows, stored.columns, stored.meta || { fileName: 'Saved report', uploadedAt: '', rowCount: stored.rawRows.length, columns: stored.columns });
    hideLoading();
    showDashboard();
  } else {
    hideLoading();
    showContextScreen();
  }
}
document.addEventListener('DOMContentLoaded', init);

})();
