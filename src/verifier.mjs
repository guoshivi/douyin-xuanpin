import { isDeepStrictEqual } from 'node:util';
import {assertPublicSafe} from './public-safety.mjs';
import {productLink} from './product-links.mjs';
export function failure(code) { const e=new Error(code); e.code=code; return e; }
export function safeCode(e, fallback='OPERATION_FAILED') { return /^[A-Z][A-Z0-9_]{0,63}$/.test(e?.code??'')?e.code:fallback; }
export function assertNumericId(value) { if(typeof value!=='string'||!/^\d{19}$/.test(value))throw failure('ID_INVALID'); return value; }
export function verifyReadback(expected, actual) { if(!isDeepStrictEqual(expected,actual))throw failure('EXACT_READBACK_MISMATCH'); return {verified:true}; }
export function verifyIdentity(candidate) { for(const k of ['product_id','promotion_id','commodity_id'])assertNumericId(candidate?.[k]); if(candidate.commodity_id!==candidate.promotion_id)throw failure('PROMOTION_ID_MISMATCH'); return candidate; }
export function verifyCart(candidate, actual) { verifyIdentity(candidate); if(actual?.row_key!==candidate.promotion_id||actual?.commodity_id!==candidate.commodity_id||actual?.product_id!==candidate.product_id||actual?.promotion_id!==candidate.promotion_id)throw failure('CART_READBACK_MISMATCH'); return {verified:true}; }
export function publicCandidate(p) { const out={}; for(const k of ['commodity_id','product_id','promotion_id','title','category_ids','metrics','seasonal_evidence','trend_series','trend_label_evidence','display_fields','source_url','captured_at','state','provisional_reason','rank_reason','seasonal_status','trend_status','rule_results'])if(p[k]!==undefined)out[k]=p[k];out.source_url=productLink(p);assertPublicSafe(out); return out; }
