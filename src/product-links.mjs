const host='buyin.jinritemai.com',route='/dashboard/merch-picking-library/merch-promoting';
const invalid=()=>{throw Object.assign(new Error('PRODUCT_LINK_INVALID'),{code:'PRODUCT_LINK_INVALID'});};
export function productLink(p){
 if(!['product_id','commodity_id','promotion_id'].every(k=>typeof p?.[k]==='string'&&/^\d{19}$/.test(p[k]))||p.commodity_id!==p.promotion_id)invalid();
 const values={id:p.commodity_id,commodity_id:p.commodity_id,product_id:p.product_id};
 if(p.source_url!=null){let u;try{u=new URL(p.source_url);}catch{invalid();}if(typeof p.source_url!=='string'||u.protocol!=='https:'||u.hostname!==host||u.port||u.username||u.password||u.hash||u.pathname!==route||[...u.searchParams].length!==3||Object.entries(values).some(([k,v])=>u.searchParams.getAll(k).length!==1||u.searchParams.get(k)!==v)||[...u.searchParams.keys()].some(k=>!Object.hasOwn(values,k)))invalid();}
 return `https://${host}${route}?id=${p.commodity_id}&commodity_id=${p.commodity_id}&product_id=${p.product_id}`;
}
export function projectedProductLink(p){try{return productLink(p);}catch{return null;}}
