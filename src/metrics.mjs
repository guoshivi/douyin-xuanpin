const MISSING_RE = /^(?:\s*|-|—|–|暂无|未展示|无权限|未知|N\/A|NA)\s*$/iu;
function numericAtom(text) {
  const m = String(text).trim().match(/^([0-9]+(?:\.[0-9]+)?)(万|亿)?$/u);
  if (!m) return null;
  const n = Number(m[1]); const factor = m[2] === '万' ? 10000 : m[2] === '亿' ? 100000000 : 1;
  const v = n * factor;
  return Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? v : null;
}
function cleanNumberText(text) {
  let s = text.trim().replace(/[¥￥]/gu, '').replace(/\s+/gu, '').replace(/元$/u, '');
  // commas are accepted only as ordinary thousands separators
  if (/,/u.test(s) && !/^\d{1,3}(?:,\d{3})*(?:\.\d+)?(?:万|亿)?[+]?$/.test(s)) return null;
  return s.replace(/,/gu, '');
}
function invalid(base) { return {...base, precision:'unparsed', missing_reason:'无法解析'}; }
export function parseMetric(raw, unit = 'count') {
  const base = {raw: raw == null ? null : raw, value:null, lower:null, upper:null, unit, precision:'missing', missing_reason:null};
  if (raw == null || (typeof raw === 'string' && MISSING_RE.test(raw))) return {...base, missing_reason: raw == null ? '未提供' : '未展示'};
  if (!['count','CNY','fraction'].includes(unit)) return invalid(base);
  if (typeof raw !== 'string' && typeof raw !== 'number') return invalid(base);
  if (typeof raw === 'number' && (!Number.isFinite(raw) || raw < 0 || !Number.isSafeInteger(raw) && unit === 'count')) return invalid(base);
  let text = String(raw).trim();
  if (!text || /(?:约|大约|左右|起|以上|以下)/u.test(text)) return invalid(base);
  const hasPercent = /%$/u.test(text);
  if (unit === 'fraction' && !hasPercent) return invalid(base);
  if (unit !== 'fraction' && hasPercent) return invalid(base);
  if (hasPercent) text = text.slice(0, -1);
  const divisor = hasPercent ? 100 : 1;
  // permit ranges with hyphen, en dash, tilde, 至; do not treat a leading minus as range
  const normalized = cleanNumberText(text);
  if (!normalized) return invalid(base);
  const range = normalized.match(/^(.+?)(?:~|～|至|–|—|-)(.+)$/u);
  if (range && !/^\d/.test(normalized)) return invalid(base);
  if (range) {
    const a = numericAtom(range[1]); const b = numericAtom(range[2]);
    if (a == null || b == null || a > b || (unit === 'count' && (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)))) return invalid(base);
    const lower = a / divisor; const upper = b / divisor;
    if (unit === 'fraction' && (upper > 1 || lower < 0)) return invalid(base);
    return {...base,value:null,lower,upper,precision:'range'};
  }
  const lowerBound = normalized.endsWith('+');
  const atom = numericAtom(lowerBound ? normalized.slice(0, -1) : normalized);
  if (atom == null) return invalid(base);
  const value = atom / divisor;
  if (!Number.isFinite(value) || value < 0 || (unit === 'fraction' && value > 1)) return invalid(base);
  if (unit === 'count' && !Number.isSafeInteger(atom)) return invalid(base);
  if (lowerBound) return {...base,value:null,lower:value,upper:null,precision:'lower_bound'};
  return {...base,value,lower:value,upper:value,precision:'exact'};
}
export function moneyToMinor(raw) {
  const m = parseMetric(raw, 'CNY');
  if (m.precision !== 'exact' || m.value == null) return null;
  const s = typeof raw === 'string' ? raw.replace(/[¥￥,\s]/gu, '').replace(/元$/u, '') : String(raw);
  const [, frac=''] = s.split('.');
  const minor = Math.round(m.value * 100);
  return Number.isSafeInteger(minor) && frac.length <= 2 ? minor : null;
}
function calendarDate(s) {
  if(typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(s))return false;
  const [y,m,d]=s.split('-').map(Number),t=new Date(Date.UTC(y,m-1,d));
  return t.getUTCFullYear()===y&&t.getUTCMonth()===m-1&&t.getUTCDate()===d;
}
function comparableMeta(a,b) {
  const keys = ['period','scope','denominator','commodity_id','sku_id','region','order_status','unit'];
  if(!keys.every(k => typeof a?.[k] === 'string' && a[k].trim() !== '' && typeof b?.[k] === 'string' && b[k].trim() !== '' && a[k] === b[k]))return false;
  // A rolling label or capture time cannot prove the statistics window.
  if(![a.start,a.end,b.start,b.end].every(calendarDate)||a.start!==b.start||a.end!==b.end||a.start>=a.end)return false;
  return a.unit==='fraction';
}
export function pooledConversion(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0];
  if (!rows.every(r => r && comparableMeta(r, first) && r.precision === 'exact' && Number.isSafeInteger(r.numerator) && Number.isSafeInteger(r.denominator_count) && r.numerator >= 0 && r.denominator_count > 0 && r.numerator <= r.denominator_count)) return null;
  let numerator = 0, denominator = 0;
  for (const r of rows) { numerator += r.numerator; denominator += r.denominator_count; if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) return null; }
  if (denominator <= 0 || numerator > denominator) return null;
  return {value:numerator / denominator, numerator, denominator_count:denominator, period:first.period, scope:first.scope, denominator:first.denominator, commodity_id:first.commodity_id, sku_id:first.sku_id, region:first.region, order_status:first.order_status, unit:first.unit, precision:'exact', ...(first.start!=null?{start:first.start,end:first.end}:{})};
}
