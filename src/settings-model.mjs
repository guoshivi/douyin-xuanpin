import fs from 'node:fs/promises';
import {READ_DRAFT_DEFAULTS,SCAN_DRAFT_KEYS,readDraft,readFromDraft} from './selection-read-state.mjs';
import {DECISION_DRAFT_DEFAULTS,decisionDraft,decisionFromDraft} from './decision-signals.mjs';
import {SCAN_FIELDS,scanSettings,scanDraft,scanFromDraft} from './scan-control.mjs';
import {selectionSettings} from './selection-filters.mjs';
import { DEFAULT_VIDEO_ROOT, getVideoRoot, validateVideoRoot } from './storage-settings.mjs';

export const EDITABLE_DRAFT_FIELDS = Object.freeze([
  ...SCAN_DRAFT_KEYS,...Object.keys(READ_DRAFT_DEFAULTS),...Object.keys(DECISION_DRAFT_DEFAULTS),
  'seasonalEnabled','seasonalReferenceDate','seasonalNotes','recentSurgeEnabled','recentDays','baselineDays','minimumGrowthRatePercent',
  'includeCategories','excludeCategories','priceMin','priceMax','priceBasis','commissionRatePercent','commissionPerOrder',
  'salesPeriod','salesMin','conversionScope','conversionDenominator','conversionMinPercent','conversionMinSample',
  'missingDataStrategy','maxCartAdditions','maxLibraryPages','maxCandidates','videoSaveRoot',
  'collectOnly','dailySalesWindow','dailySalesMin','risingDaysMin','firstPositiveDaysMax','dailySalesMax','risingDaysMax','firstPositiveDaysMin','dailySalesEnabled','risingDaysEnabled','firstPositiveEnabled','selectionCombination'
]);

const PRICE_BASES = new Set(['displayed','take_home','sku']);
const SALES_PERIODS = new Set(['platform_current','snapshot','recent_7d','recent_30d','orders','items']);
const CONVERSION_SCOPES = new Set(['product','video']);
const CONVERSION_DENOMINATORS = new Set(['paid_orders','orders','clicks','visitors','exposure']);
const MISSING_STRATEGIES = new Set(['decision_page','manual_review']);
const BUSINESS_MODES = new Set(['affiliate','self_store']);
const POLICY_KEYS = new Set(['schema_version','policy_version','confirmed','business_modes','categories','priorities','focus_metrics','numeric_filters_enabled','rules','decisions','allow_provisional_cart','limits','video_scope','feishu','storage','selection','scan_control']);
const RULE_KEYS = new Set(['metric','op','min','max','unit','scope','period','denominator','min_sample','required']);
const METRICS = new Set(['price','commission_rate','commission_amount','sales','conversion_rate']);
const FOCUS_METRICS = new Set(['price','commission_rate','sales','conversion_rate']);

export function defaultPolicy() {
  return {
    schema_version: 2,
    policy_version: 'season-surge-v1',
    confirmed: true,
    business_modes: ['affiliate', 'self_store'],
    categories: { include: [], exclude: [], optional: true, confirmed: true },
    priorities: {
      seasonal: { enabled: true, mode: 'prefer', reference_date: null, timezone: 'Asia/Shanghai', notes: '' },
      recent_surge: { enabled: true, mode: 'prefer', recent_days: 7, baseline_days: 7, minimum_growth_rate: null }
    },
    focus_metrics: ['price', 'commission_rate', 'sales', 'conversion_rate'],
    numeric_filters_enabled: false,
    rules: [],
    decisions: { price_sku_basis: null, sales_period: null, conversion_scope: null, conversion_denominator: null, minimum_conversion_sample: null },
    allow_provisional_cart: true,
    limits: { max_library_pages: 3, max_candidates: 60, max_cart_additions: 3, browser_concurrency: 1, download_concurrency: 2, max_round_ms: 90000, max_run_minutes: 30, readback_attempts: 3 },
    video_scope: { page: 1, sort: 'site_default', minimum_likes: null },
    feishu: { identity: 'user', upload_main_images: true, upload_videos: false },
    storage: { video_root: DEFAULT_VIDEO_ROOT }
  };
}

export function optionalNumber(raw, { min = 0, max = Infinity } = {}) {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') throw new Error('INVALID_NUMBER');
  if (typeof raw === 'string' && !/^\d+(?:\.\d+)?$/.test(raw.trim())) throw new Error('INVALID_NUMBER');
  const value = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isFinite(value) || value < min || value > max) throw new Error('INVALID_NUMBER');
  return value;
}

export function optionalPercent(raw) {
  const value = optionalNumber(raw, { min: 0, max: 100 });
  return value === null ? null : value / 100;
}

function strictDate(raw, field = 'date') {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`${field}:INVALID_DATE`);
  const [y,m,d] = raw.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw new Error(`${field}:INVALID_DATE`);
  return raw;
}

function positiveInt(raw, field) {
  const value = optionalNumber(raw, { min: 1, max: Number.MAX_SAFE_INTEGER });
  if (value !== null && (!Number.isSafeInteger(value))) throw new Error(`${field}:INVALID_INTEGER`);
  if (value === null) throw new Error(`${field}:REQUIRED`);
  return value;
}
function optionalInt(raw, field, {min = 0} = {}) {
  const value = optionalNumber(raw, { min, max: Number.MAX_SAFE_INTEGER });
  if (value !== null && !Number.isSafeInteger(value)) throw new Error(`${field}:INVALID_INTEGER`);
  return value;
}
function asText(raw, field, {allowNull = true, maxLength = 2000} = {}) {
  if (raw == null && allowNull) return null;
  if (typeof raw !== 'string' || raw.length > maxLength) throw new Error(`${field}:INVALID_TEXT`);
  return raw;
}
function ids(raw, field) {
  if (!Array.isArray(raw)) throw new Error(`${field}:INVALID_IDS`);
  const out = [];
  for (const id of raw) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 256 || id.includes('\u0000')) throw new Error(`${field}:INVALID_ID`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}
function errorMapFrom(fn) {
  try { fn(); return { valid: true, errors: {} }; }
  catch (error) {
    const key = String(error.message || 'INVALID').split(':')[0] || 'form';
    return { valid: false, errors: { [key]: error.message || 'INVALID' } };
  }
}
function setError(errors, field, message) {
  if (!Object.hasOwn(errors, field)) Object.defineProperty(errors, field, {value:message, enumerable:true, writable:true, configurable:true});
}
function ensureKnown(obj, allowed, prefix, errors) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { setError(errors, prefix, '必须是对象'); return; }
  for (const key of Object.keys(obj)) if (!allowed.has(key)) setError(errors, `${prefix}.${key}`, '未知字段');
}

const selectionFields=[...SCAN_DRAFT_KEYS,...Object.keys(READ_DRAFT_DEFAULTS),...Object.keys(DECISION_DRAFT_DEFAULTS),'collectOnly','dailySalesWindow','dailySalesMin','risingDaysMin','firstPositiveDaysMax','dailySalesMax','risingDaysMax','firstPositiveDaysMin','dailySalesEnabled','risingDaysEnabled','firstPositiveEnabled','selectionCombination'];
function selectionFromDraft(draft,current){
 const s=readFromDraft(draft,selectionSettings(current));
 if(Object.keys(DECISION_DRAFT_DEFAULTS).some(k=>Object.hasOwn(draft,k)))s.decision=decisionFromDraft(draft,s.decision);
 if(Object.hasOwn(draft,'collectOnly')){if(typeof draft.collectOnly!=='boolean')throw new Error('selection:INVALID_BOOLEAN');s.mode=draft.collectOnly?'collect_only':'archive';}
 if(Object.hasOwn(draft,'dailySalesWindow')){const n=optionalNumber(draft.dailySalesWindow,{min:1,max:30});if(!Number.isSafeInteger(n))throw new Error('selection:INVALID_WINDOW');s.daily_window=n;}
 for(const [field,key]of [['dailySalesMin','daily_min'],['risingDaysMin','rising_days_min'],['firstPositiveDaysMax','first_positive_days_max'],['dailySalesMax','daily_max'],['risingDaysMax','rising_days_max'],['firstPositiveDaysMin','first_positive_days_min']])if(Object.hasOwn(draft,field))s[key]=optionalNumber(draft[field],{max:Number.MAX_SAFE_INTEGER});
 for(const [field,key]of [['dailySalesEnabled','daily_enabled'],['risingDaysEnabled','rising_enabled'],['firstPositiveEnabled','first_positive_enabled']])if(Object.hasOwn(draft,field)){if(typeof draft[field]!=='boolean')throw new Error('selection:INVALID_BOOLEAN');s[key]=draft[field];}
 if(Object.hasOwn(draft,'selectionCombination'))s.combination=draft.selectionCombination;
 return selectionSettings(s);
}
function normalizedDraft(draft) {
  return {
    videoSaveRoot: validateVideoRoot(draft.videoSaveRoot),
    seasonalEnabled: typeof draft.seasonalEnabled === 'boolean' ? draft.seasonalEnabled : (() => { throw new Error('seasonalEnabled:INVALID_BOOLEAN'); })(),
    seasonalReferenceDate: strictDate(draft.seasonalReferenceDate, 'seasonalReferenceDate'),
    seasonalNotes: asText(draft.seasonalNotes ?? '', 'seasonalNotes', {allowNull:false}),
    recentSurgeEnabled: typeof draft.recentSurgeEnabled === 'boolean' ? draft.recentSurgeEnabled : (() => { throw new Error('recentSurgeEnabled:INVALID_BOOLEAN'); })(),
    recentDays: positiveInt(draft.recentDays, 'recentDays'),
    baselineDays: positiveInt(draft.baselineDays, 'baselineDays'),
    minimumGrowthRatePercent: optionalNumber(draft.minimumGrowthRatePercent, {min:0}),
    includeCategories: ids(draft.includeCategories ?? [], 'includeCategories'),
    excludeCategories: ids(draft.excludeCategories ?? [], 'excludeCategories'),
    priceMin: optionalNumber(draft.priceMin, {min:0}),
    priceMax: optionalNumber(draft.priceMax, {min:0}),
    priceBasis: asText(draft.priceBasis, 'priceBasis'),
    commissionRatePercent: optionalNumber(draft.commissionRatePercent, {min:0,max:100}),
    commissionPerOrder: optionalNumber(draft.commissionPerOrder, {min:0}),
    salesPeriod: asText(draft.salesPeriod, 'salesPeriod'),
    salesMin: optionalNumber(draft.salesMin, {min:0}),
    conversionScope: asText(draft.conversionScope, 'conversionScope'),
    conversionDenominator: asText(draft.conversionDenominator, 'conversionDenominator'),
    conversionMinPercent: optionalNumber(draft.conversionMinPercent, {min:0,max:100}),
    conversionMinSample: optionalInt(draft.conversionMinSample, 'conversionMinSample'),
    missingDataStrategy: asText(draft.missingDataStrategy, 'missingDataStrategy'),
    maxCartAdditions: positiveInt(draft.maxCartAdditions, 'maxCartAdditions'),
    maxLibraryPages: positiveInt(draft.maxLibraryPages, 'maxLibraryPages'),
    maxCandidates: positiveInt(draft.maxCandidates, 'maxCandidates')
  };
}

export function validateDraft(draft, categoryCatalog = []) {
  const errors = {};
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return {valid:false, errors:{draft:'必须是对象'}};
  for (const key of Object.keys(draft)) if (!EDITABLE_DRAFT_FIELDS.includes(key)) setError(errors, key, '未知或受保护字段');
  try{selectionFromDraft(draft);}catch{setError(errors,'selection','筛选设置无效：日销非负，连涨1–30，首次正销1–30天');}
  try{scanFromDraft(draft);}catch{setError(errors,'scan_control','扫描设置无效：开关须布尔，次数须正整数，毫秒须0–2147483647整数');}
  const d = {};
  const parsers = {
    videoSaveRoot: () => validateVideoRoot(draft.videoSaveRoot),
    seasonalEnabled: () => typeof draft.seasonalEnabled === 'boolean' ? draft.seasonalEnabled : (() => { throw new Error('INVALID_BOOLEAN'); })(),
    seasonalReferenceDate: () => strictDate(draft.seasonalReferenceDate, 'seasonalReferenceDate'),
    seasonalNotes: () => asText(draft.seasonalNotes ?? '', 'seasonalNotes', {allowNull:false}),
    recentSurgeEnabled: () => typeof draft.recentSurgeEnabled === 'boolean' ? draft.recentSurgeEnabled : (() => { throw new Error('INVALID_BOOLEAN'); })(),
    recentDays: () => positiveInt(draft.recentDays, 'recentDays'), baselineDays: () => positiveInt(draft.baselineDays, 'baselineDays'),
    minimumGrowthRatePercent: () => optionalNumber(draft.minimumGrowthRatePercent, {min:0}),
    includeCategories: () => ids(draft.includeCategories ?? [], 'includeCategories'), excludeCategories: () => ids(draft.excludeCategories ?? [], 'excludeCategories'),
    priceMin: () => optionalNumber(draft.priceMin, {min:0}), priceMax: () => optionalNumber(draft.priceMax, {min:0}), priceBasis: () => asText(draft.priceBasis, 'priceBasis'),
    commissionRatePercent: () => optionalNumber(draft.commissionRatePercent, {min:0,max:100}), commissionPerOrder: () => optionalNumber(draft.commissionPerOrder, {min:0}),
    salesPeriod: () => asText(draft.salesPeriod, 'salesPeriod'), salesMin: () => optionalNumber(draft.salesMin, {min:0}),
    conversionScope: () => asText(draft.conversionScope, 'conversionScope'), conversionDenominator: () => asText(draft.conversionDenominator, 'conversionDenominator'),
    conversionMinPercent: () => optionalNumber(draft.conversionMinPercent, {min:0,max:100}), conversionMinSample: () => optionalInt(draft.conversionMinSample, 'conversionMinSample'),
    missingDataStrategy: () => asText(draft.missingDataStrategy, 'missingDataStrategy'), maxCartAdditions: () => positiveInt(draft.maxCartAdditions, 'maxCartAdditions'),
    maxLibraryPages: () => positiveInt(draft.maxLibraryPages, 'maxLibraryPages'), maxCandidates: () => positiveInt(draft.maxCandidates, 'maxCandidates')
  };
  for (const [field, parser] of Object.entries(parsers)) {
    try { d[field] = parser(); } catch (error) { setError(errors, field, String(error.message || '字段格式无效').replace(/^.*?:/, '') || '字段格式无效'); d[field] = null; }
  }
  if (Object.keys(errors).length) return {valid:false, errors};
  for (const [field, allowed] of [['priceBasis', PRICE_BASES], ['salesPeriod', SALES_PERIODS], ['conversionScope', CONVERSION_SCOPES], ['conversionDenominator', CONVERSION_DENOMINATORS]]) {
    if (d[field] !== null && d[field] !== '' && !allowed.has(d[field])) setError(errors, field, '不支持的统计口径');
  }
  if (d.priceMin !== null && d.priceMax !== null && d.priceMin > d.priceMax) setError(errors, 'priceMin', '最低价格不能高于最高价格');
  if ((d.priceMin !== null || d.priceMax !== null) && !PRICE_BASES.has(d.priceBasis)) setError(errors, 'priceBasis', '设置价格条件时必须选择价格口径');
  if (d.salesMin !== null && !SALES_PERIODS.has(d.salesPeriod)) setError(errors, 'salesPeriod', '设置销量条件时必须选择销量周期');
  const conversionEnabled = d.conversionMinPercent !== null || d.conversionMinSample !== null;
  if (conversionEnabled) {
    if (!CONVERSION_SCOPES.has(d.conversionScope)) setError(errors, 'conversionScope', '设置转化条件时必须选择口径');
    if (!CONVERSION_DENOMINATORS.has(d.conversionDenominator)) setError(errors, 'conversionDenominator', '设置转化条件时必须选择分母');
  }
  
  const catalogIds = new Set((Array.isArray(categoryCatalog) ? categoryCatalog : []).map(x => typeof x === 'string' ? x : x?.id).filter(x => typeof x === 'string'));
  for (const [field, values] of [['includeCategories',d.includeCategories],['excludeCategories',d.excludeCategories]]) {
    for (const id of values) if (!catalogIds.has(id)) setError(errors, field, 'CATEGORY_NOT_AVAILABLE:类目选项未加载或类目 ID 不存在');
  }
  if (d.includeCategories.some(id => d.excludeCategories.includes(id))) setError(errors, 'categories', '包含与排除类目不能重叠');
  if (!MISSING_STRATEGIES.has(d.missingDataStrategy)) setError(errors, 'missingDataStrategy', '缺数据策略无效');
  return {valid:Object.keys(errors).length===0, errors};
}

export function policyToDraft(policy) {
  const p = policy ?? defaultPolicy();
  const rule = metric => p.rules?.find(r => r.metric === metric);
  const price = rule('price'), commissionRate = rule('commission_rate'), commissionAmount = rule('commission_amount'), sales = rule('sales'), conversion = rule('conversion_rate');
  const s=selectionSettings(p.selection);
  return {
    ...scanDraft(p.scan_control),...readDraft(s),...decisionDraft(s.decision),
    ...(p.selection===undefined?{}:{collectOnly:s.mode==='collect_only',dailySalesWindow:String(s.daily_window),dailySalesMin:s.daily_min===null?'':String(s.daily_min),risingDaysMin:s.rising_days_min===null?'':String(s.rising_days_min),firstPositiveDaysMax:s.first_positive_days_max===null?'':String(s.first_positive_days_max),selectionCombination:s.combination??'all',dailySalesMax:s.daily_max==null?'':String(s.daily_max),risingDaysMax:s.rising_days_max==null?'':String(s.rising_days_max),firstPositiveDaysMin:s.first_positive_days_min==null?'':String(s.first_positive_days_min),dailySalesEnabled:s.daily_enabled??(s.daily_min!=null||s.daily_max!=null),risingDaysEnabled:s.rising_enabled??(s.rising_days_min!=null||s.rising_days_max!=null),firstPositiveEnabled:s.first_positive_enabled??(s.first_positive_days_min!=null||s.first_positive_days_max!=null)}),
    seasonalEnabled: p.priorities.seasonal.enabled,
    videoSaveRoot: getVideoRoot(p),
    seasonalReferenceDate: p.priorities.seasonal.reference_date ?? '',
    seasonalNotes: p.priorities.seasonal.notes ?? '',
    recentSurgeEnabled: p.priorities.recent_surge.enabled,
    recentDays: String(p.priorities.recent_surge.recent_days),
    baselineDays: String(p.priorities.recent_surge.baseline_days),
    minimumGrowthRatePercent: p.priorities.recent_surge.minimum_growth_rate == null ? '' : String(p.priorities.recent_surge.minimum_growth_rate * 100),
    includeCategories: [...(p.categories.include ?? [])],
    excludeCategories: [...(p.categories.exclude ?? [])],
    priceMin: price?.min == null ? '' : String(price.min), priceMax: price?.max == null ? '' : String(price.max), priceBasis: p.decisions.price_sku_basis ?? '',
    commissionRatePercent: commissionRate?.min == null ? '' : String(commissionRate.min * 100), commissionPerOrder: commissionAmount?.min == null ? '' : String(commissionAmount.min),
    salesPeriod: p.decisions.sales_period ?? '', salesMin: sales?.min == null ? '' : String(sales.min),
    conversionScope: p.decisions.conversion_scope ?? '', conversionDenominator: p.decisions.conversion_denominator ?? '',
    conversionMinPercent: conversion?.min == null ? '' : String(conversion.min * 100), conversionMinSample: conversion?.min_sample == null ? '' : String(conversion.min_sample),
    missingDataStrategy: p.allow_provisional_cart ? 'decision_page' : 'manual_review',
    maxCartAdditions: String(p.limits.max_cart_additions), maxLibraryPages: String(p.limits.max_library_pages), maxCandidates: String(p.limits.max_candidates)
  };
}

export function draftToPolicy(draft, currentPolicy = defaultPolicy(), categoryCatalog = []) {
  const check = validateDraft(draft, categoryCatalog);
  if (!check.valid) { const e = new Error(Object.entries(check.errors).map(([k,v]) => `${k}:${v}`).join(';')); e.errors=check.errors; throw e; }
  const d = normalizedDraft(draft);
  const p = structuredClone(currentPolicy ?? defaultPolicy());
  if(Object.keys(SCAN_FIELDS).some(k=>Object.hasOwn(draft,k)))p.scan_control=scanFromDraft(draft,p.scan_control);
  if(selectionFields.some(k=>Object.hasOwn(draft,k)))p.selection=selectionFromDraft(draft,p.selection);
  p.storage = { video_root: d.videoSaveRoot };
  p.categories = { include: d.includeCategories, exclude: d.excludeCategories, optional: true, confirmed: true };
  p.priorities.seasonal.enabled = d.seasonalEnabled; p.priorities.seasonal.reference_date = d.seasonalReferenceDate; p.priorities.seasonal.notes = d.seasonalNotes;
  p.priorities.recent_surge.enabled = d.recentSurgeEnabled; p.priorities.recent_surge.recent_days = d.recentDays; p.priorities.recent_surge.baseline_days = d.baselineDays; p.priorities.recent_surge.minimum_growth_rate = d.minimumGrowthRatePercent === null ? null : d.minimumGrowthRatePercent / 100;
  p.decisions.price_sku_basis = d.priceBasis || null; p.decisions.sales_period = d.salesPeriod || null; p.decisions.conversion_scope = d.conversionScope || null; p.decisions.conversion_denominator = d.conversionDenominator || null; p.decisions.minimum_conversion_sample = d.conversionMinSample;
  p.allow_provisional_cart = d.missingDataStrategy === 'decision_page';
  p.limits.max_cart_additions=d.maxCartAdditions; p.limits.max_library_pages=d.maxLibraryPages; p.limits.max_candidates=d.maxCandidates;
  const rules=[];
  if (d.priceMin !== null || d.priceMax !== null) rules.push({metric:'price',op:'range',min:d.priceMin,max:d.priceMax,unit:'CNY',scope:'product',period:'snapshot',denominator:null,min_sample:null,required:true});
  if (d.commissionRatePercent !== null) rules.push({metric:'commission_rate',op:'gte',min:d.commissionRatePercent/100,max:null,unit:'fraction',scope:'product',period:'snapshot',denominator:null,min_sample:null,required:true});
  if (d.commissionPerOrder !== null) rules.push({metric:'commission_amount',op:'gte',min:d.commissionPerOrder,max:null,unit:'CNY',scope:'product',period:'snapshot',denominator:null,min_sample:null,required:true});
  if (d.salesMin !== null) rules.push({metric:'sales',op:'gte',min:d.salesMin,max:null,unit:'count',scope:'product',period:d.salesPeriod,denominator:null,min_sample:null,required:true});
  if (d.conversionMinPercent !== null || d.conversionMinSample !== null) rules.push({metric:'conversion_rate',op:'gte',min:d.conversionMinPercent===null?null:d.conversionMinPercent/100,max:null,unit:'fraction',scope:d.conversionScope,period:'snapshot',denominator:d.conversionDenominator,min_sample:d.conversionMinSample,required:true});
  p.rules=rules; p.numeric_filters_enabled=rules.length>0; p.confirmed=true;
  const valid=validatePolicy(p,categoryCatalog); if(!valid.valid){const e=new Error(Object.entries(valid.errors).map(([k,v])=>`${k}:${v}`).join(';'));e.errors=valid.errors;throw e;}
  return p;
}

export function validatePolicy(policy, categoryCatalog = []) {
  const errors={};
  ensureKnown(policy,POLICY_KEYS,'policy',errors); if (Object.keys(errors).length) return {valid:false,errors};
  try{selectionSettings(policy.selection);}catch{setError(errors,'selection','筛选设置无效');}
  try{scanSettings(policy.scan_control);}catch{setError(errors,'scan_control','扫描设置无效');}
  if (policy.schema_version !== 2 || typeof policy.policy_version !== 'string' || policy.policy_version.length===0 || policy.confirmed !== true) setError(errors,'policy_version','配置版本或 confirmed 无效');
  if (!Array.isArray(policy.business_modes) || policy.business_modes.length!==BUSINESS_MODES.size || new Set(policy.business_modes).size!==BUSINESS_MODES.size || !policy.business_modes.every(x=>BUSINESS_MODES.has(x))) setError(errors,'business_modes','业务模式无效');
  if (!policy.categories || !Array.isArray(policy.categories.include) || !Array.isArray(policy.categories.exclude)) setError(errors,'categories','类目结构无效');
  else {
    ensureKnown(policy.categories,new Set(['include','exclude','optional','confirmed']),'categories',errors);
    if (policy.categories.optional !== true || policy.categories.confirmed !== true) setError(errors,'categories','类目配置标记无效');
    const idsAll=[...policy.categories.include,...policy.categories.exclude]; if (!idsAll.every(x=>typeof x==='string'&&x.length>0&&x.length<=256)) setError(errors,'categories','类目 ID 必须是字符串');
    if(policy.categories.include.some(x=>policy.categories.exclude.includes(x)))setError(errors,'categories','包含与排除类目不能重叠');
    if (Array.isArray(categoryCatalog) && categoryCatalog.length > 0) { const known=new Set(categoryCatalog.map(x=>typeof x==='string'?x:x?.id)); for(const id of idsAll)if(!known.has(id))setError(errors,'categories','类目 ID 不存在'); }
  }
  const s=policy.priorities?.seasonal, t=policy.priorities?.recent_surge;
  if (!s || !t) setError(errors,'priorities','优先设置缺失'); else {
    ensureKnown(policy.priorities,new Set(['seasonal','recent_surge']),'priorities',errors);
    ensureKnown(s,new Set(['enabled','mode','reference_date','timezone','notes']),'priorities.seasonal',errors);
    ensureKnown(t,new Set(['enabled','mode','recent_days','baseline_days','minimum_growth_rate']),'priorities.recent_surge',errors);
    if(typeof s.enabled!=='boolean'||typeof t.enabled!=='boolean')setError(errors,'priorities','enabled 必须是布尔值');
    if(typeof s.timezone!=='string'||s.timezone!=='Asia/Shanghai')setError(errors,'priorities','时区受保护');
    if(typeof s.notes!=='string'||typeof s.mode!=='string'||typeof t.mode!=='string'||s.mode!=='prefer'||t.mode!=='prefer')setError(errors,'priorities','优先设置无效');
    try{strictDate(s.reference_date,'reference_date')}catch{setError(errors,'reference_date','日期无效')}
    if(!Number.isSafeInteger(t.recent_days)||t.recent_days<1||!Number.isSafeInteger(t.baseline_days)||t.baseline_days<1)setError(errors,'priorities','观察窗口无效');
    if(t.minimum_growth_rate!==null&&(!Number.isFinite(t.minimum_growth_rate)||t.minimum_growth_rate<0))setError(errors,'minimum_growth_rate','增长率无效');
  }
  if (!Array.isArray(policy.focus_metrics) || policy.focus_metrics.length !== FOCUS_METRICS.size || new Set(policy.focus_metrics).size !== FOCUS_METRICS.size || !policy.focus_metrics.every(x=>FOCUS_METRICS.has(x))) setError(errors,'focus_metrics','重点指标无效');
  if (!policy.decisions || typeof policy.decisions !== 'object') setError(errors,'decisions','决策口径缺失'); else {
    ensureKnown(policy.decisions,new Set(['price_sku_basis','sales_period','conversion_scope','conversion_denominator','minimum_conversion_sample']),'decisions',errors);
    if(policy.decisions.price_sku_basis!==null&&!PRICE_BASES.has(policy.decisions.price_sku_basis))setError(errors,'price_sku_basis','价格口径无效');
    if(policy.decisions.sales_period!==null&&!SALES_PERIODS.has(policy.decisions.sales_period))setError(errors,'sales_period','销量周期无效');
    if(policy.decisions.conversion_scope!==null&&!CONVERSION_SCOPES.has(policy.decisions.conversion_scope))setError(errors,'conversion_scope','转化口径无效');
    if(policy.decisions.conversion_denominator!==null&&!CONVERSION_DENOMINATORS.has(policy.decisions.conversion_denominator))setError(errors,'conversion_denominator','转化分母无效');
    if(policy.decisions.minimum_conversion_sample!==null&&(!Number.isSafeInteger(policy.decisions.minimum_conversion_sample)||policy.decisions.minimum_conversion_sample<0))setError(errors,'minimum_conversion_sample','样本量无效');
  }
  if (!Array.isArray(policy.rules)) setError(errors,'rules','规则必须是数组'); else {
    const seen=new Set();
    for(const [i,r] of policy.rules.entries()) {
      ensureKnown(r,RULE_KEYS,`rules[${i}]`,errors);
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      if(!METRICS.has(r.metric))setError(errors,`rules[${i}]`,'指标无效');
      if(seen.has(r.metric))setError(errors,`rules[${i}]`,'同一指标不能重复'); seen.add(r.metric);
      if(!['range','gte'].includes(r.op))setError(errors,`rules[${i}]`,'操作符无效');
      if(!['product','video'].includes(r.scope))setError(errors,`rules[${i}]`,'范围无效');
      if(typeof r.period!=='string'||r.period.length===0)setError(errors,`rules[${i}]`,'周期无效');
      if(r.denominator!==null&&typeof r.denominator!=='string')setError(errors,`rules[${i}]`,'分母无效');
      if(typeof r.unit!=='string'||r.unit.length===0)setError(errors,`rules[${i}]`,'单位无效');
      if(typeof r.required!=='boolean')setError(errors,`rules[${i}]`,'required 必须是布尔值');
      for(const k of ['min','max'])if(r[k]!==null&&(!Number.isFinite(r[k])||r[k]<0||(['commission_rate','conversion_rate'].includes(r.metric)&&r[k]>1)))setError(errors,`rules[${i}]`,'数值无效');
      if(Number.isFinite(r.min)&&Number.isFinite(r.max)&&r.min>r.max)setError(errors,`rules[${i}]`,'区间无效');
      if(r.min_sample!==null&&(!Number.isSafeInteger(r.min_sample)||r.min_sample<0))setError(errors,`rules[${i}]`,'样本量无效');
    }
  }
  if (policy.numeric_filters_enabled !== (policy.rules?.length>0)) setError(errors,'numeric_filters_enabled','必须由 rules 派生');
  if (!policy.limits || !['max_library_pages','max_candidates','max_cart_additions'].every(k=>Number.isSafeInteger(policy.limits[k])&&policy.limits[k]>0))setError(errors,'limits','运行预算必须是正整数');
  if (policy.limits) ensureKnown(policy.limits,new Set(['max_library_pages','max_candidates','max_cart_additions','browser_concurrency','download_concurrency','max_round_ms','max_run_minutes','readback_attempts']),'limits',errors);
  if(policy.limits && (policy.limits.browser_concurrency!==1||policy.limits.download_concurrency!==2||policy.limits.max_round_ms!==90000||policy.limits.max_run_minutes!==30||policy.limits.readback_attempts!==3))setError(errors,'limits','保护性运行配置受保护');
  if(policy.video_scope) ensureKnown(policy.video_scope,new Set(['page','sort','minimum_likes']),'video_scope',errors);
  if(policy.video_scope?.page!==1||policy.video_scope?.sort!=='site_default'||policy.video_scope?.minimum_likes!==null) setError(errors,'video_scope','视频范围受保护');
  if(policy.feishu) ensureKnown(policy.feishu,new Set(['identity','upload_main_images','upload_videos']),'feishu',errors);
  if(policy.feishu?.identity!=='user'||policy.feishu?.upload_main_images!==true||policy.feishu?.upload_videos!==false)setError(errors,'feishu','飞书配置受保护');
  if (policy.allow_provisional_cart !== true && policy.allow_provisional_cart !== false) setError(errors,'allow_provisional_cart','缺数据策略必须是布尔值');
  if (policy.storage !== undefined) {
    ensureKnown(policy.storage,new Set(['video_root']),'storage',errors);
    try { getVideoRoot(policy); } catch { setError(errors,'videoSaveRoot','VIDEO_SAVE_ROOT_INVALID'); }
  }
  return {valid:Object.keys(errors).length===0,errors};
}

export async function loadPolicyFile(filePath, categoryCatalog=[]) {
  const text = await fs.readFile(filePath,'utf8'); const policy=JSON.parse(text); const result=validatePolicy(policy,categoryCatalog); if(!result.valid){const e=new Error('INVALID_POLICY');e.errors=result.errors;throw e;} return policy;
}
