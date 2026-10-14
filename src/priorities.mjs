import {evaluateProduct} from './policy.mjs';
function validDate(s){
  if(typeof s!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return null;
  const [y,m,d]=s.split('-').map(Number), x=new Date(Date.UTC(y,m-1,d));
  return x.getUTCFullYear()===y&&x.getUTCMonth()===m-1&&x.getUTCDate()===d?x:null;
}
function days(a,b){return Math.round((b-a)/86400000)}
function exactTotal(t){return t&&t.precision==='exact'&&Number.isSafeInteger(t.value)&&t.value>=0&&(t.lower==null||t.lower===t.value)&&(t.upper==null||t.upper===t.value)}
function fail(reason){return {verified:false,status:'unverified',trend_status:'unverified',label:null,reason,new_activity:null,growth_rate:null,absolute_increment_per_day:null}}
function nonempty(v){return typeof v==='string'&&v.trim()!==''}
export function computeTrend({recent,baseline}={},settings={}){
  const s=settings?.priorities?.recent_surge ?? settings?.recent_surge ?? settings;
  if(!recent||!baseline)return fail('缺少近期或基期');
  const rs=validDate(recent.start),re=validDate(recent.end),bs=validDate(baseline.start),be=validDate(baseline.end);
  if(!rs||!re||!bs||!be)return fail('日期格式无效');
  const rd=days(rs,re),bd=days(bs,be);
  if(rd<=0||bd<=0||recent.days!==rd||baseline.days!==bd||(s.recent_days!=null&&s.recent_days!==rd)||(s.baseline_days!=null&&s.baseline_days!==bd)||be.getTime()!==rs.getTime())return fail('窗口必须是相邻不重叠且长度与设置一致');
  if(!exactTotal(recent.total)||!exactTotal(baseline.total))return fail('总量不是安全精确值');
  const keys=['commodity_id','sku_id','region','order_status','unit','scope','denominator'];
  if(!keys.every(k=>nonempty(recent[k])&&nonempty(baseline[k])&&recent[k]===baseline[k]))return fail('统计口径或商品范围不一致');
  if((recent.period!=null&&!nonempty(recent.period))||(baseline.period!=null&&!nonempty(baseline.period))||/累计|overlap|重叠/iu.test(`${recent.period??''} ${baseline.period??''}`))return fail('累计或重叠口径不可用于趋势');
  const rt=recent.total.value,bt=baseline.total.value,rav=rt/rd,bav=bt/bd,inc=rav-bav;
  if(!Number.isFinite(rav)||!Number.isFinite(bav))return fail('计算结果非有限');
  const basis={period:'adjacent-half-open',unit:recent.unit,scope:recent.scope,denominator:recent.denominator,commodity_id:recent.commodity_id,sku_id:recent.sku_id,region:recent.region,order_status:recent.order_status,start:recent.start,end:recent.end,baseline_start:baseline.start,baseline_end:baseline.end};
  if(bt===0)return {...fail(rt>0?'基期为零，标记新起量':'近期与基期均为零'),verified:true,status:rt>0?'new_activity':'verified',trend_status:rt>0?'new_activity':'verified',label:rt>0?'new_activity':null,new_activity:rt>0,growth_rate:null,recent_total:rt,baseline_total:bt,recent_days:rd,baseline_days:bd,recent_avg:rav,baseline_avg:bav,absolute_increment_per_day:inc,basis};
  return {verified:true,status:'verified',trend_status:'verified',label:null,new_activity:false,recent_total:rt,baseline_total:bt,recent_days:rd,baseline_days:bd,recent_avg:rav,baseline_avg:bav,absolute_increment_per_day:inc,growth_rate:rav/bav-1,basis};
}
function evidenceArray(v){return Array.isArray(v)?v:v?[v]:[]}
function sourceGood(x){if(!x||typeof x.source_url!=='string'||!/^https?:\/\//iu.test(x.source_url)||typeof x.source_text!=='string'||!x.source_text.trim()||typeof x.captured_at!=='string'||Number.isNaN(Date.parse(x.captured_at)))return false;try{const u=new URL(x.source_url);return !u.username&&!u.password}catch{return false}}
export function evaluateSeasonality({evidence,reference_date,region='CN'}={}){
  const items=evidenceArray(evidence), ref=validDate(reference_date);
  const usable=items.filter(x=>{if(!sourceGood(x)||(x.source==='user_input')||x.region!=null&&x.region!==region)return false; const explicit=x.matched===true||x.product_match===true&&x.time_match===true&&x.region_match===true; if(!explicit)return false; return !x.reference_date||!ref||x.reference_date===reference_date;});
  if(usable.some(x=>x.year_round===true||x.season==='全年'))return {status:'year_round',reason:'证据标明全年适用',evidence:usable};
  if(usable.length)return {status:'matched',reason:'有来源、原文、时间且已证实匹配',evidence:usable};
  return {status:'unverified',reason:items.some(x=>x?.source==='user_input')?'用户偏好不能替代平台事实证据':'缺少可核来源的匹配证据',evidence:[],user_input:items.filter(x=>x?.source==='user_input')};
}
function platformLabel(v){const ev=evidenceArray(v);return ev.length>0&&ev.every(sourceGood)&&ev.some(x=>x.matched===true&&(x.trend_match===true||x.surge_match===true||/起量|增长|上涨|飙升/iu.test(x.source_text)));}
function trendInfo(p,policy){
  const raw=p.trend_series;
  const series=raw?.recent&&raw?.baseline?raw:raw?.provenance?.recent&&raw?.provenance?.baseline?raw.provenance:null;
  if(series){
    const c=series.recent.commodity_id===p.commodity_id&&series.baseline.commodity_id===p.commodity_id?computeTrend(series,policy):fail('趋势窗口不属于该商品');
    return {numeric:c.verified&&Number.isFinite(c.growth_rate),computed:c,platform:false};
  }
  const ev=p.trend_label_evidence; if(platformLabel(ev))return {numeric:false,computed:null,platform:true,evidence:evidenceArray(ev)};
  return {numeric:false,computed:null,platform:false};
}
function basisKey(t){const b=t?.basis;if(!b)return null;return JSON.stringify(['unit','scope','denominator','region','order_status','period','start','end','baseline_start','baseline_end'].map(k=>b[k]??null))}
function localDate(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date())}
function retainedState(product,result){
  for(const state of ['blocked','rejected','needs_review'])if(product.state===state||result.state===state)return state;
  return result.state;
}
function reviewReasons(product,result){
  const reasons=[];
  if(product.state==='needs_review')reasons.push(product.provisional_reason||product.reason||'已有待复核条件未解除');
  if(result.state==='needs_review')reasons.push(result.reason||result.provisional_reason||'商品规则待复核');
  return [...new Set(reasons)];
}
export function rankCandidates(products=[],policy={}, {archiveDate}={}){
  const seasonalOn=policy.priorities?.seasonal?.enabled===true, trendOn=policy.priorities?.recent_surge?.enabled===true, min=policy.priorities?.recent_surge?.minimum_growth_rate;
  if(!seasonalOn&&!trendOn){
    const ranked=products.map(p=>{const v=evaluateProduct(p,policy),state=retainedState(p,v),reasons=reviewReasons(p,v);return {...p,state,rule_results:v.rule_results,rank_reason:'按平台当前列表顺序探索',provisional_reason:reasons.length?reasons.join('；'):null};});
    return {ranked,selected:ranked.filter(p=>!['rejected','blocked'].includes(p.state)&&(policy.allow_provisional_cart!==false||p.state!=='needs_review')).slice(0,policy.limits?.max_cart_additions??0)};
  }
  const date=archiveDate||policy.priorities?.seasonal?.reference_date||localDate();
  const rows=products.map((p,index)=>{
    const evaled=evaluateProduct(p,policy), seasonal=evaluateSeasonality({evidence:p.seasonal_evidence,reference_date:date}), ti=trendInfo(p,policy), t=ti.computed;
    const seasonGood=seasonal.status==='matched'||seasonal.status==='year_round', trendGood=ti.numeric||ti.platform||(t?.verified&&t.status==='new_activity');
    let provisional=null, lowReject=false;
    if(min!=null&&trendOn){if(ti.numeric&&Number.isFinite(t.growth_rate)&&t.growth_rate<min){lowReject=true;provisional='实际增幅低于用户设置的最低增幅';}else if(!ti.numeric)provisional='缺少可比数值增幅，最低增幅未能核验';}
    const tier=seasonalOn&&trendOn?(seasonGood&&trendGood?0:(seasonGood||trendGood?1:2)):seasonalOn?(seasonGood?0:2):trendOn?(trendGood?0:2):4;
    const gaps=reviewReasons(p,evaled);if(seasonalOn&&!seasonGood)gaps.push('应季证据未核实');if(trendOn&&!trendGood)gaps.push('近期起量证据未核实');if(provisional)gaps.push(provisional);
    const reason=!seasonalOn&&!trendOn?'按平台当前列表顺序探索':tier===0?'应季与近期起量均有证据':tier===1?'至少一项优先证据已核实':'缺少优先证据，保留待补数据';
    return {...p,state:retainedState(p,evaled),rule_results:evaled.rule_results,seasonal_status:seasonal.status,seasonal_reason:seasonal.reason,seasonal_evidence:seasonal.evidence,trend_status:t?.trend_status??(ti.platform?'platform_label':'unverified'),trend_details:t??null,trend_basis:t?.verified?t.basis:ti.platform?'platform_label':null,growth_rate:ti.numeric?t.growth_rate:null,absolute_increment_per_day:ti.numeric?t.absolute_increment_per_day:null,rank_reason:reason,provisional_reason:gaps.length?gaps.join('；'):null,__tier:tier,__index:index,__numeric:ti.numeric,__platform:ti.platform,__basis:basisKey(t),__lowReject:lowReject,__growthFloorUnverified:min!=null&&trendOn&&!ti.numeric};
  });
  const groups=new Map();for(const r of rows){const k=r.__numeric&&r.__basis?`${r.__tier}:n:${r.__basis}`:`${r.__tier}:t:${r.__platform?'platform':'unknown'}`;(groups.get(k)||groups.set(k,[]).get(k)).push(r);}
  const ordered=[...groups.values()].sort((a,b)=>a[0].__tier-b[0].__tier||a[0].__index-b[0].__index).flatMap(g=>g.sort((a,b)=>a.__numeric&&b.__numeric?((b.growth_rate-a.growth_rate)||((b.absolute_increment_per_day||0)-(a.absolute_increment_per_day||0))||a.__index-b.__index):a.__index-b.__index));
  const allow=policy.allow_provisional_cart!==false, max=policy.limits?.max_cart_additions??0, selected=[];
  for(const r of ordered){if(selected.length>=max||['rejected','blocked'].includes(r.state)||r.__lowReject)continue;if((r.state==='needs_review'||r.__growthFloorUnverified)&&!allow)continue;if((r.__tier>=2)&&!allow)continue;selected.push(r)}
  const clean=x=>{const y={...x};for(const k of ['__tier','__index','__numeric','__platform','__basis','__lowReject','__growthFloorUnverified'])delete y[k];return y};return {ranked:ordered.map(clean),selected:selected.map(clean)};
}
