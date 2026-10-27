const fail=code=>{throw Object.assign(Error(code),{code});};
export const BUSINESS_CATEGORIES=Object.freeze([['7','智能家居'],['5','个护家清'],['14','3C数码家电'],['10','母婴宠物'],['13','食品饮料'],['8','生鲜'],['16','鞋靴箱包'],['19','钟表配饰'],['2','玩具乐器'],['18','运动户外'],['4','服饰内衣'],['9','美妆'],['15','图书教育'],['11','鲜花园艺'],['17','虚拟充值'],['12','本地生活'],['20','珠宝文玩']].map(([id,name])=>Object.freeze({id,name,cate_type:1})));
export const VERIFIED_FILTERS=Object.freeze({business_category:'BusinessCid',price:'Price',commission_cos:'CosRatio',sales_30d:'alliance_sales_30d'});
export function buildPlatformPrefilter(c={enabled:false}){
 if(!c||typeof c!=='object'||Array.isArray(c)||typeof c.enabled!=='boolean')fail('PREFILTER_CONFIG_INVALID');
 if(Object.keys(c).some(k=>!['enabled','local_rules','business_categories','price_min','price_max','commission_cos_min','commission_cos_max','sales_30d_min'].includes(k)))fail('PREFILTER_CONFIG_INVALID');
 const cats=c.business_categories??[];if(!Array.isArray(cats)||cats.some(x=>typeof x!=='string'||!BUSINESS_CATEGORIES.some(k=>k.id===x)))fail('PREFILTER_CATEGORY_INVALID');
 for(const k of ['price_min','price_max','commission_cos_min','commission_cos_max','sales_30d_min']){const v=c[k];if(v!=null&&(typeof v!=='number'||!Number.isFinite(v)||v<0||k.startsWith('commission')&&v>100||k==='sales_30d_min'&&!Number.isSafeInteger(v)))fail('PREFILTER_NUMBER_INVALID');}
 for(const k of ['price','commission_cos'])if(c[k+'_min']!=null&&c[k+'_max']!=null&&c[k+'_min']>c[k+'_max'])fail('PREFILTER_RANGE_INVALID');
 if(!c.enabled)return {enabled:false,request:null,reasons:['DISABLED']};const filters={};if(cats.length)filters.BusinessCid={value:[...new Set(cats)]};
 const add=(key,min,max)=>{if(min==null&&max==null)return;filters[key]={value:[`R:${min??0},${max??'-'}`]};};add('Price',c.price_min,c.price_max);add('CosRatio',c.commission_cos_min,c.commission_cos_max);add('alliance_sales_30d',c.sales_30d_min,null);
 return {enabled:true,request:{scene:'PCSquareFeed',size:30,cursor:0,filters,search_text:''},requests:(cats.length?[...new Set(cats)]:[null]).map(id=>({scene:'PCSquareFeed',size:30,cursor:0,filters:{...filters,...(id?{BusinessCid:{value:[id]}}:{})},search_text:''})),reasons:[],source:'native_ui_material_list',scope:'first_screen',combination:'explicit_additional_and',price_unit:'CNY',commission_basis:'cos'};
}
export function validatePlatformResponse(response,request,observedRequest){const same=JSON.stringify(request)===JSON.stringify(observedRequest);return {ok:!!request&&same&&response?.code===0&&Array.isArray(response.data?.summary_promotions),scope:'first_screen',reason:same?'BUSINESS_RESPONSE_REQUIRED':'REQUEST_BINDING_MISMATCH'};}
