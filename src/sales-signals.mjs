// Daily observations only: these signals do not certify lifecycle novelty or trend basis.
const DAY=86400000;
const count=v=>Number.isSafeInteger(v)&&v>=0;
const metric=(value=null,reason=null)=>({value,status:reason?'unverified':'verified',reason});
function dateValue(value,compact=false){
 if(typeof value!=='string'||!(compact?/^\d{8}$/:/^\d{4}-\d{2}-\d{2}$/).test(value))return null;
 const text=compact?`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`:value;
 const date=new Date(`${text}T00:00:00.000Z`);
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===text?date.getTime():null;
}
const iso=day=>new Date(day).toISOString().slice(0,10);
const windowOf=points=>({start:points.length?iso(dateValue(points[0].x,true)):null,end:points.length?iso(dateValue(points.at(-1).x,true)):null,days:points.length});
export function analyzeSaleAxis(input={}){
 const {sale_axis,month_sale,reference_date}=input??{};
 const ref=dateValue(reference_date),refReason=reference_date==null?'reference_date_missing':ref===null?'reference_date_invalid':null;
 const month=count(month_sale)?metric(month_sale):metric(null,month_sale==null?'month_sale_missing':'month_sale_invalid');
 const out={schema_version:1,status:'unverified',reason:null,axis_status:'unverified',axis_reason:null,reference_date:ref===null?null:reference_date,
  points:[],observation_window:windowOf([]),completed_window:windowOf([]),excluded_today_count:0,stale_days:null,
  yesterday:metric(null,'axis_missing'),average_3d:metric(null,'axis_missing'),average_7d:metric(null,'axis_missing'),rising_days:metric(null,'axis_missing'),rising_transitions:null,
  first_positive:{date:null,days_before_reference:null,left_censored:null,status:'unverified',reason:'axis_missing',lifecycle_first_unknown:true},new_product_verified:false,
  month_sale:month,axis_total:metric(null,'axis_missing'),axis_total_basis:'complete_observation_axis_including_today',month_minus_axis:metric(null,'axis_missing')};
 const reject=reason=>{out.reason=out.axis_reason=reason;for(const k of ['yesterday','average_3d','average_7d','rising_days','axis_total','month_minus_axis'])out[k]=metric(null,reason);out.first_positive.reason=reason;return out;};
 if(sale_axis==null)return reject('axis_missing');
 if(!Array.isArray(sale_axis))return reject('axis_invalid');
 if(!sale_axis.length)return reject('axis_empty');
 if(sale_axis.length>30)return reject('axis_too_long');
 const points=[];
 for(const p of sale_axis){
  if(!p||typeof p!=='object'||Array.isArray(p))return reject('point_invalid');
  const day=dateValue(p.x,true);if(day===null)return reject('date_invalid');
  if(!count(p.y))return reject('sales_invalid');
  if(ref!==null&&day>ref)return reject('future_date');
  points.push({x:p.x,y:p.y});
 }
 points.sort((a,b)=>a.x.localeCompare(b.x));
 let total=0;
 for(let i=0;i<points.length;i++){
  if(i){const delta=dateValue(points[i].x,true)-dateValue(points[i-1].x,true);if(delta===0)return reject('duplicate_date');if(delta!==DAY)return reject('date_gap');}
  total+=points[i].y;if(!Number.isSafeInteger(total))return reject('axis_total_overflow');
 }
 out.points=points;out.observation_window=windowOf(points);out.axis_status='verified';out.axis_total=metric(total);
 out.month_minus_axis=month.status==='verified'?metric(month.value-total):metric(null,month.reason);
 const complete=ref===null?[]:points.filter(p=>dateValue(p.x,true)<ref);
 out.completed_window=windowOf(complete);out.excluded_today_count=ref===null?0:points.length-complete.length;
 // With no reference, retain observed first-positive date but never claim completed days or age.
 const firstWindow=ref===null?points:complete,first=firstWindow.find(p=>p.y>0);
 out.first_positive={date:first?iso(dateValue(first.x,true)):null,days_before_reference:first&&ref!==null?(ref-dateValue(first.x,true))/DAY:null,
  left_censored:first?first===firstWindow[0]:null,status:ref===null?'unverified':'observed',reason:refReason??(first?null:'no_positive_in_window'),lifecycle_first_unknown:true};
 const unavailable=reason=>{out.reason=reason;for(const k of ['yesterday','average_3d','average_7d','rising_days'])out[k]=metric(null,reason);return out;};
 if(refReason)return unavailable(refReason);
 if(!complete.length)return unavailable('no_completed_points');
 out.stale_days=(ref-DAY-dateValue(complete.at(-1).x,true))/DAY;
 if(out.stale_days>0){out.status='stale';return unavailable('stale_axis');}
 out.status='verified';out.yesterday=metric(complete.at(-1).y);
 for(const n of [3,7])out[`average_${n}d`]=complete.length<n?metric(null,`insufficient_${n}d`):metric(complete.slice(-n).reduce((sum,p)=>sum+p.y,0)/n);
 let rising=1;for(let i=complete.length-1;i>0&&complete[i].y>complete[i-1].y;i--)rising++;
 out.rising_days=metric(rising,complete.length===1?'insufficient_growth_points':null);out.rising_transitions=rising-1;
 return out;
}

// Recompute the public schema from observations, never from self-reported metrics.
const signalRecord=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const rejectedAxisReasons=new Set(['axis_missing','axis_invalid','axis_empty','axis_too_long','point_invalid','date_invalid','sales_invalid','future_date','duplicate_date','date_gap','axis_total_overflow']);
export function publicSalesSignals(value){
 if(!signalRecord(value)||value.schema_version!==1)return analyzeSaleAxis();
 const month=value.month_sale;
 const monthValid=signalRecord(month)&&month.status==='verified'&&month.reason===null&&count(month.value);
 const out=analyzeSaleAxis({sale_axis:value.points,reference_date:value.reference_date,month_sale:monthValid?month.value:undefined});
 if(!monthValid){
  const reason=month==null||(signalRecord(month)&&month.value==null&&month.reason==='month_sale_missing')?'month_sale_missing':'month_sale_invalid';
  out.month_sale=metric(null,reason);
  if(out.axis_status==='verified')out.month_minus_axis=metric(null,reason);
 }
 // Rejected raw axes were discarded by analysis. Retain only an enum diagnostic;
 // no fabricated replacement axis and no self-reported numbers can revive them.
 if(Array.isArray(value.points)&&value.points.length===0&&rejectedAxisReasons.has(value.axis_reason)){
  out.reason=out.axis_reason=value.axis_reason;
  for(const k of ['yesterday','average_3d','average_7d','rising_days','axis_total','month_minus_axis'])out[k]=metric(null,value.axis_reason);
  out.first_positive.reason=value.axis_reason;
 }
 // A null normalized reference can carry the original invalid-vs-missing diagnosis.
 if(value.reference_date==null&&(value.reason==='reference_date_invalid'||(signalRecord(value.first_positive)&&value.first_positive.reason==='reference_date_invalid'))){
  if(out.reason==='reference_date_missing')out.reason='reference_date_invalid';
  for(const k of ['yesterday','average_3d','average_7d','rising_days'])if(out[k].reason==='reference_date_missing')out[k]=metric(null,'reference_date_invalid');
  if(out.first_positive.reason==='reference_date_missing')out.first_positive.reason='reference_date_invalid';
 }
 return out;
}
