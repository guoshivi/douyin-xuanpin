import {validatePolicy} from './settings-model.mjs';

function matchesMeta(metric, rule) {
  if (!metric || typeof metric !== 'object') return false;
  for (const key of ['unit','scope','period','denominator']) if (rule[key] != null && metric[key] !== rule[key]) return false;
  if (rule.min_sample != null && (!Number.isSafeInteger(metric.sample_count) || metric.sample_count < rule.min_sample)) return false;
  return true;
}
function bounds(m) {
  if (!m || typeof m !== 'object' || ['missing','unparsed'].includes(m.precision)) return [null,null];
  const lo = m.precision === 'exact' ? m.value : m.lower;
  const hi = m.precision === 'exact' ? m.value : m.upper;
  return [Number.isFinite(lo) ? lo : null, Number.isFinite(hi) ? hi : null];
}
export function checkRule(metric, rule) {
  if (!rule || !['gte','range'].includes(rule.op) || !matchesMeta(metric, rule)) return 'needs_review';
  if (rule.min_sample != null && metric.sample_count < rule.min_sample) return 'needs_review';
  const [low, high] = bounds(metric); if (low == null && high == null) return 'needs_review';
  if (rule.op === 'gte') {
    if (rule.min == null) return rule.min_sample != null ? 'pass' : 'needs_review';
    if (low != null && low >= rule.min) return 'pass';
    if (high != null && high < rule.min) return 'reject';
    return 'needs_review';
  }
  const min = rule.min == null ? -Infinity : rule.min;
  const max = rule.max == null ? Infinity : rule.max;
  if (low != null && low >= min && (max === Infinity || (high != null && high <= max))) return 'pass';
  if ((high != null && high < min) || (low != null && low > max)) return 'reject';
  return 'needs_review';
}
export function categoriesResult(product, policy) {
  const include = policy.categories?.include ?? [], exclude = policy.categories?.exclude ?? [];
  if (!include.length && !exclude.length) return {state:'pass', reason:'未启用类目限制'};
  const ids = product.category_ids;
  if (!Array.isArray(ids) || !ids.every(x => typeof x === 'string')) return {state:'needs_review', reason:'商品类目缺失或不是字符串数组'};
  if (!ids.length) return {state:'needs_review', reason:'商品类目缺失，无法核验启用的类目限制'};
  if (exclude.some(x => ids.includes(x))) return {state:'reject', reason:'命中排除类目'};
  if (include.length && !include.some(x => ids.includes(x))) return {state:'reject', reason:'未命中包含类目'};
  return {state:'pass', reason:'类目限制已核验'};
}
export function evaluateProduct(product = {}, policy = {}) {
  const result = {state:'blocked', rule_results:[], reason:null, commodity_id:product.commodity_id ?? null, provisional_reason:null};
  if (typeof product.commodity_id !== 'string' || !/^\d+$/u.test(product.commodity_id)) { result.reason='商品 ID 缺失或不是数字字符串'; return result; }
  if (!policy || policy.confirmed !== true || !Array.isArray(policy.rules)) { result.reason='POLICY_NOT_CONFIRMED'; return result; }
  const cat = categoriesResult(product, policy);
  if (cat.state === 'reject') { result.state='rejected'; result.reason=cat.reason; return result; }
  if (cat.state === 'needs_review') { result.state='needs_review'; result.reason=cat.reason; }
  const source = product.metrics && typeof product.metrics === 'object' ? product.metrics : product;
  for (const rule of policy.rules) {
    const metric = source[rule.metric];
    let check = checkRule(metric, rule);
    if (rule.metric === 'price' && policy.numeric_filters_enabled) {
      const basis = policy.decisions?.price_sku_basis;
      if (basis != null && (!metric || metric.sku_basis !== basis)) check = 'needs_review';
    }
    result.rule_results.push({metric:rule.metric, required:rule.required !== false, result:check});
  }
  const required = result.rule_results.filter(x => x.required);
  if (required.some(x => x.result === 'reject')) result.state='rejected';
  else if (required.some(x => x.result === 'needs_review') || result.state === 'needs_review') { result.state='needs_review'; result.provisional_reason ??= '存在缺失或口径未核验的必需条件'; }
  else result.state='eligible';
  return result;
}
export function validateRuntimePolicy(policy, catalog = []) {
  const base = validatePolicy(policy, catalog), errors = [];
  if (!base.valid) errors.push(...Object.entries(base.errors).map(([k,v]) => `${k}:${v}`));
  if (policy?.numeric_filters_enabled && Array.isArray(policy.rules)) for (const rule of policy.rules) {
    if (rule.metric === 'price' && !policy.decisions?.price_sku_basis) errors.push('decisions.price_sku_basis:启用价格过滤必须明确价格 SKU 口径');
    if (rule.metric === 'sales' && !policy.decisions?.sales_period) errors.push('decisions.sales_period:启用销量过滤必须明确周期');
    if (rule.metric === 'conversion_rate' && (!policy.decisions?.conversion_scope || !policy.decisions?.conversion_denominator)) errors.push('decisions.conversion:启用转化过滤必须明确范围与分母');
    if (rule.op === 'range' && rule.min == null && rule.max == null && rule.min_sample == null) errors.push(`rules.${rule.metric}:区间至少需要一个边界`);
  }
  return {ok:errors.length===0, errors};
}
