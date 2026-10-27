const KEYS=['order_rate','creator_share','video_share'];
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function validateDecisionConfig(c={enabled:false}){
 if(!c||typeof c!=='object'||Array.isArray(c)||typeof c.enabled!=='boolean')fail('DECISION_CONFIG_INVALID');
 const allowed=['enabled','window_days','share_basis','combination',...KEYS.flatMap(k=>[k+'_enabled',k+'_min',k+'_max'])];
 if(Object.keys(c).some(k=>!allowed.includes(k)))fail('DECISION_CONFIG_INVALID');
 const out={...c,window_days:c.window_days??30,share_basis:c.share_basis??'sales',combination:c.combination??'all'};
 if(![7,30].includes(out.window_days))fail('DECISION_WINDOW_UNSUPPORTED');
 if(!['sales','sales_amount'].includes(out.share_basis)||!['all','any'].includes(out.combination))fail('DECISION_CONFIG_INVALID');
 for(const k of KEYS){if(c[k+'_enabled']!==undefined&&typeof c[k+'_enabled']!=='boolean')fail('DECISION_CONFIG_INVALID');for(const side of ['min','max']){const v=c[k+'_'+side];if(v!=null&&(!finite(v)||k!=='order_rate'&&v>100))fail('DECISION_NUMBER_INVALID');}if(c[k+'_min']!=null&&c[k+'_max']!=null&&c[k+'_min']>c[k+'_max'])fail('DECISION_RANGE_INVALID');}
 return out;
}
export const decisionEnabled=c=>{const s=validateDecisionConfig(c);return s.enabled&&KEYS.some(k=>s[k+'_enabled']!==false&&(s[k+'_min']!=null||s[k+'_max']!=null));};
const metric=(v,raw=null)=>({value:finite(v)?v:null,raw,unit:'percent',precision:finite(v)?'interface_value':'missing'});
function datesValid(d,n){if(!Array.isArray(d)||d.length!==n)return false;let prev=null;for(const x of d){if(typeof x!=='string'||!/^\d{8}$/.test(x))return false;const iso=x.slice(0,4)+'-'+x.slice(4,6)+'-'+x.slice(6),time=Date.parse(iso+'T00:00:00Z');if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==iso||prev!==null&&time-prev!==86400000)return false;prev=time;}return true;}
export function projectDecisionResponse(body,{promotion_id,product_id,window_days=30,share_basis='sales',calculate_dates}={}){
 const pd=body?.data?.model?.promotion_data,identity=body?.code===0&&body.data?.promotion_id===promotion_id&&body.data?.product_id===product_id&&pd?.code===0;
 const list=pd?.stat_data?.promotion_stat_data_list;
 const share=(title,key)=>{if(!identity||!Array.isArray(list))return null;const rows=list.filter(x=>x?.title===title),stats=rows.length===1?rows[0]?.stat_data?.[share_basis]?.stat_list:null;if(!Array.isArray(stats))return null;const hits=stats.filter(x=>x?.key===key);return hits.length===1&&finite(hits[0].value)&&hits[0].value<=100?hits[0].value:null;};
 const rate=identity&&finite(pd?.calculate_data?.order_conversion_rate)?pd.calculate_data.order_conversion_rate:null;
 const formatted=pd?.calculate_data?.format_order_conversion_rate;
 const observations={identity_verified:identity,rate,formatted:typeof formatted==='string'&&/^\d+(?:\.\d+)?%(?:[~～-]\d+(?:\.\d+)?%)?$/.test(formatted)?formatted:null,creator_share:share('销售渠道','达人带货'),video_share:share('达人带货方式','视频'),dates:(calculate_dates??pd?.calculate_data_list?.map(x=>x.calculate_time)??[]).map(x=>typeof x==='number'&&Number.isSafeInteger(x)?String(x):x)};
 return publicDecision({schema_version:1,promotion_id,product_id,window_days,share_basis,observations});
}
export function publicDecision(d){
 const unknown={status:'unverified',order_rate:metric(null),creator_share:metric(null),video_share:metric(null)};
 if(!d||d.schema_version!==1||!/^\d{19}$/.test(typeof d.promotion_id==='string'?d.promotion_id:'')||!/^\d{19}$/.test(typeof d.product_id==='string'?d.product_id:'')||![7,30].includes(d.window_days)||!['sales','sales_amount'].includes(d.share_basis))return unknown;
 const o=d.observations;if(!o||typeof o!=='object'||Array.isArray(o)||typeof o.identity_verified!=='boolean'||!Array.isArray(o.dates)||o.dates.length>30||o.dates.some(x=>typeof x!=='string'||!/^\d{8}$/.test(x))||['rate','creator_share','video_share'].some(k=>o[k]!==null&&!finite(o[k]))||['creator_share','video_share'].some(k=>o[k]>100)||o.formatted!==null&&(typeof o.formatted!=='string'||!/^\d+(?:\.\d+)?%(?:[~～-]\d+(?:\.\d+)?%)?$/.test(o.formatted)))return unknown;
 const observations={identity_verified:o.identity_verified,rate:o.rate,formatted:o.formatted,creator_share:o.creator_share,video_share:o.video_share,dates:[...o.dates]};
 return {schema_version:1,promotion_id:d.promotion_id,product_id:d.product_id,window_days:d.window_days,share_basis:d.share_basis,observations,status:o.identity_verified&&datesValid(o.dates,d.window_days)?'verified':'unverified',order_rate:metric(o.identity_verified&&o.rate!==null?o.rate*100:null,o.rate),order_rate_formatted:o.formatted,creator_share:metric(o.identity_verified?o.creator_share:null),video_share:metric(o.identity_verified?o.video_share:null),source:'native_pack_detail',denominator:'orders_per_detail_exposure',scope:'platform_chart'};
}
export function evaluateDecisionSignals(d,cfg={enabled:false}){
 const c=validateDecisionConfig(cfg),p=publicDecision(d),checks=[];
 if(c.enabled)for(const key of KEYS){const min=c[key+'_min']??null,max=c[key+'_max']??null;if(c[key+'_enabled']===false||min===null&&max===null)continue;const value=p[key]?.value??null,verified=p.status==='verified'&&p.window_days===c.window_days&&p.share_basis===c.share_basis;
 checks.push({key,min,max,actual:verified?value:null,unit:'percent',state:!verified||value===null?'needs_review':min!==null&&value<min||max!==null&&value>max?'rejected':'matched'});}
 const state=!checks.length?'matched':c.combination==='any'?(checks.some(x=>x.state==='matched')?'matched':checks.some(x=>x.state==='needs_review')?'needs_review':'rejected'):(checks.some(x=>x.state==='rejected')?'rejected':checks.some(x=>x.state==='needs_review')?'needs_review':'matched');return {state,checks,combination:c.combination,applied:checks.length>0};
}
// Versioned receipts are independent of the immutable discovery observation.
export function detailRows(task,rows){
 const v=task.snapshot.selection_detail_version;if(v===undefined){if(task.selection_details!==undefined)fail('SELECTION_DETAIL_INVALID');return rows;}if(v!==1||!Array.isArray(task.selection_details))fail('SELECTION_DETAIL_INVALID');
 const cfg=validateDecisionConfig(task.snapshot.policy.selection?.decision),seen=new Set(),map=new Map(rows.map(r=>[r.commodity_id,r]));
 for(const r of task.selection_details){const row=map.get(r?.commodity_id);if(!r||Object.keys(r).sort().join(',')!=='commodity_id,decision,fetch_state'||r.fetch_state!=='completed'||!row||seen.has(r.commodity_id))fail('SELECTION_DETAIL_INVALID');const p=publicDecision(r.decision);if(JSON.stringify(p)!==JSON.stringify(r.decision)||p.schema_version!==1||p.promotion_id!==row.promotion_id||p.product_id!==row.product_id||p.window_days!==cfg.window_days||p.share_basis!==cfg.share_basis)fail('SELECTION_DETAIL_INVALID');seen.add(r.commodity_id);}
 return rows.map(r=>{const d=task.selection_details.find(x=>x.commodity_id===r.commodity_id);return d?{...r,selection_decision:d.decision}:r;});
}
export const DECISION_DRAFT_DEFAULTS={decisionEnabled:false,decisionWindow:'30',decisionBasis:'sales',decisionCombination:'all',orderRateEnabled:false,orderRateMin:'',orderRateMax:'',creatorShareEnabled:false,creatorShareMin:'',creatorShareMax:'',videoShareEnabled:false,videoShareMin:'',videoShareMax:''};
const fields={decisionEnabled:'enabled',decisionWindow:'window_days',decisionBasis:'share_basis',decisionCombination:'combination',orderRateEnabled:'order_rate_enabled',orderRateMin:'order_rate_min',orderRateMax:'order_rate_max',creatorShareEnabled:'creator_share_enabled',creatorShareMin:'creator_share_min',creatorShareMax:'creator_share_max',videoShareEnabled:'video_share_enabled',videoShareMin:'video_share_min',videoShareMax:'video_share_max'};
export function decisionDraft(c){if(c===undefined)return {};const s=validateDecisionConfig(c);return Object.fromEntries(Object.entries(fields).map(([f,k])=>[f,s[k]==null?DECISION_DRAFT_DEFAULTS[f]:typeof DECISION_DRAFT_DEFAULTS[f]==='boolean'?s[k]:String(s[k])]));}
export function decisionFromDraft(d,current){const c=validateDecisionConfig(current);for(const [f,k]of Object.entries(fields))if(Object.hasOwn(d,f)){const v=d[f];if(k==='window_days'||k.endsWith('_min')||k.endsWith('_max')){if(v===''||v===null)c[k]=null;else{if(typeof v!=='number'&&(typeof v!=='string'||!/^\d+(?:\.\d+)?$/.test(v)))fail('DECISION_NUMBER_INVALID');c[k]=Number(v);}}else c[k]=v;}return validateDecisionConfig(c);}
