import {validateDecisionConfig,decisionEnabled,evaluateDecisionSignals} from './decision-signals.mjs';
import {validateCreatorConfig} from './creator-signals.mjs';
import {buildPlatformPrefilter} from './platform-prefilter.mjs';
import {publicSalesSignals} from './sales-signals.mjs';
import {evaluateProduct} from './policy.mjs';
import {computeTrend} from './priorities.mjs';

export const SELECTION_DEFAULTS=Object.freeze({mode:'archive',daily_window:1,daily_min:null,rising_days_min:null,first_positive_days_max:null});
export function selectionSettings(value){
 if(value===undefined)return {...SELECTION_DEFAULTS};
 const bad=()=>{const e=new Error('SELECTION_INVALID');e.code='TASK_MODE_INVALID';throw e;};
 const optional=['creator','prefilter','decision','daily_max','rising_days_max','first_positive_days_min','daily_enabled','rising_enabled','first_positive_enabled','combination'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(SELECTION_DEFAULTS).some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!Object.hasOwn(SELECTION_DEFAULTS,k)&&!optional.includes(k)))bad();
 for(const k of ['daily_enabled','rising_enabled','first_positive_enabled'])if(Object.hasOwn(value,k)&&typeof value[k]!=='boolean')bad();
 if(Object.hasOwn(value,'combination')&&!['all','any'].includes(value.combination))bad();
 if(!['archive','collect_only'].includes(value.mode)||!Number.isSafeInteger(value.daily_window)||value.daily_window<1||value.daily_window>30)bad();
 for(const [key,min,max,integer]of [['daily_min',0,Number.MAX_SAFE_INTEGER,false],['rising_days_min',1,30,true],['first_positive_days_max',1,30,true]]){const n=value[key];if(n!==null&&(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max||integer&&!Number.isSafeInteger(n)))bad();}
 for(const [key,min,max]of [['daily_max',0,Number.MAX_SAFE_INTEGER],['rising_days_max',1,30],['first_positive_days_min',1,30]])if(Object.hasOwn(value,key)&&value[key]!==null){const n=value[key];if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max||key!=='daily_max'&&!Number.isSafeInteger(n))bad();}
 for(const [a,b]of [['daily_min','daily_max'],['rising_days_min','rising_days_max'],['first_positive_days_min','first_positive_days_max']])if(value[a]!=null&&value[b]!=null&&value[a]>value[b])bad();
 if(value.decision!==undefined)validateDecisionConfig(value.decision);
 if(value.creator!==undefined)validateCreatorConfig(value.creator);if(value.prefilter!==undefined)buildPlatformPrefilter(value.prefilter);
 return {...value};
}
export function selectionEnabled(policy){const s=selectionSettings(policy?.selection);return decisionEnabled(s.decision)||[['daily_enabled','daily_min','daily_max'],['rising_enabled','rising_days_min','rising_days_max'],['first_positive_enabled','first_positive_days_min','first_positive_days_max']].some(([enabled,...keys])=>s[enabled]!==false&&keys.some(k=>s[k]!=null));}
const stateOf=checks=>checks.some(x=>x.state==='rejected')?'rejected':checks.some(x=>x.state==='needs_review')?'needs_review':'matched';
export function evaluateSelection(candidate,policy){
 const s=selectionSettings(policy?.selection),signals=publicSalesSignals(candidate?.sales_signals),checks=[];
 const add=(key,expected,actual,verified,op='gte')=>{if(expected===null)return;const state=!verified||actual===null?'needs_review':(op==='gte'?actual>=expected:actual<=expected)?'matched':'rejected';checks.push({key,expected,actual:verified?actual:null,op,state,reason:state==='matched'?'threshold_met':state==='rejected'?'threshold_not_met':'evidence_unverified'});};
 const completed=signals.points.filter(p=>p.x<signals.reference_date?.replaceAll('-',''));
 const daily=signals[s.daily_window===1?'yesterday':`average_${s.daily_window}d`]??(signals.status==='verified'&&completed.length>=s.daily_window?{value:completed.slice(-s.daily_window).reduce((n,p)=>n+p.y,0)/s.daily_window,status:'verified',reason:null}:{value:null,status:'unverified',reason:signals.status==='verified'?'insufficient_window':'evidence_unverified'});
 if(s.daily_enabled!==false){add('daily_'+s.daily_window+'d',s.daily_min,daily.value,daily.status==='verified');add('daily_'+s.daily_window+'d',s.daily_max??null,daily.value,daily.status==='verified','lte');}
 if(s.rising_enabled!==false){add('rising_days',s.rising_days_min,signals.rising_days.value,signals.rising_days.status==='verified');add('rising_days',s.rising_days_max??null,signals.rising_days.value,signals.rising_days.status==='verified','lte');}
 if(s.first_positive_enabled!==false){add('first_positive_days',s.first_positive_days_min??null,signals.first_positive.days_before_reference,signals.status==='verified'&&signals.first_positive.status==='observed');add('first_positive_days',s.first_positive_days_max,signals.first_positive.days_before_reference,signals.status==='verified'&&signals.first_positive.status==='observed','lte');}
 const rule_results=[['daily',s.daily_enabled,'daily_'],['rising',s.rising_enabled,'rising_days'],['first_positive',s.first_positive_enabled,'first_positive_days']].map(([key,enabled,prefix])=>{const list=checks.filter(c=>c.key.startsWith(prefix));return {key,enabled:enabled!==false&&list.length>0,state:list.length?stateOf(list):'disabled',reason:list.length?'configured_range':'no_range_limit'};});
 const active=rule_results.filter(r=>r.enabled),combination=s.combination??'all';
 const new_rule_state=!active.length?'matched':combination==='any'?(active.some(r=>r.state==='matched')?'matched':active.some(r=>r.state==='needs_review')?'needs_review':'rejected'):stateOf(active),old=evaluateProduct(candidate,policy),hard_checks=[];
 // Old overall needs_review (e.g. absent optional metrics) is retained separately, not invented as a hard rule.
 hard_checks.push({key:'configured_legacy_rules',state:old.state==='eligible'?'matched':old.state==='rejected'?'rejected':'needs_review',reason:old.state==='eligible'?'threshold_met':old.state==='rejected'?'threshold_not_met':'evidence_unverified'});
 if(['blocked','rejected'].includes(candidate?.state))hard_checks.push({key:'upstream_admission',state:'rejected',reason:'upstream_admission_denied'});
 const min=policy?.priorities?.recent_surge?.enabled===true?policy.priorities.recent_surge.minimum_growth_rate:null;
 if(min!=null&&(typeof min!=='number'||!Number.isFinite(min)))hard_checks.push({key:'configured_growth_floor',expected:null,actual:null,state:'needs_review',reason:'evidence_unverified'});
 else if(min!=null){const raw=candidate.trend_series,series=raw?.recent?raw:raw?.provenance;const t=series?.recent?.commodity_id===candidate.commodity_id&&series?.baseline?.commodity_id===candidate.commodity_id?computeTrend(series,policy):null;hard_checks.push({key:'configured_growth_floor',expected:min,actual:t?.verified&&Number.isFinite(t.growth_rate)?t.growth_rate:null,state:!t?.verified||!Number.isFinite(t.growth_rate)?'needs_review':t.growth_rate>=min?'matched':'rejected',reason:!t?.verified||!Number.isFinite(t.growth_rate)?'evidence_unverified':t.growth_rate>=min?'threshold_met':'threshold_not_met'});}
 const bound=candidate?.selection_decision?.promotion_id===candidate?.promotion_id&&candidate?.selection_decision?.product_id===candidate?.product_id;const decision=evaluateDecisionSignals(bound?candidate.selection_decision:undefined,s.decision);
 return {...(s.decision===undefined?{}:{decision}),state:stateOf([{state:new_rule_state},...(s.decision===undefined?[]:[{state:decision.state}]),...hard_checks]),new_rule_state,combination,applied:active.length>0,rule_results,checks,hard_checks,signals};
}
export function selectionCounts(rows){const result={total:rows.length,matched:0,rejected:0,needs_review:0};for(const r of rows)result[r.selection.state]++;return result;}
