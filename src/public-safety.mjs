import {assertPublicSafe as legacyAssert} from './safety.mjs';
// Additional phase4 boundary; do not alter the protected legacy safety contract.
// Round 3: bounded percent-decoding (at most 2 rounds, safe fallback) plus URL fragment
// sensitive-assignment checks; legitimate Chinese text and public product/video links stay valid.
const secretPattern=/\b(?:cookie|authorization|bearer|password|passwd|api[_-]?key|access[_-]?token|session[_-]?id)\s*[:=]/i;
const urlKeyPattern=/token|sign|auth|session|cookie|secret|credential|expires|x-amz|x-goog|policy/i;
function boundedForms(text){const forms=[text];let out=text;for(let round=0;round<2;round++){if(!out.includes('%'))break;let next;try{next=decodeURIComponent(out);}catch{break;}if(next===out)break;forms.push(next);out=next;}return forms;}
function boundedDecode(text){return boundedForms(text).at(-1);}
function secretRejected(){throw Object.assign(new Error('PUBLIC_SECRET_REJECTED'),{code:'PUBLIC_SECRET_REJECTED'});}
function urlRejected(){throw Object.assign(new Error('PUBLIC_URL_REJECTED'),{code:'PUBLIC_URL_REJECTED'});}
export function assertPublicSafe(value){
 legacyAssert(value);
 const visit=x=>{if(typeof x==='string'){
  for(const text of boundedForms(x)){
  if(secretPattern.test(text))secretRejected();
  for(const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)){let url;try{url=new URL(match[0]);}catch{urlRejected();}if(url.username||url.password||[...url.searchParams.keys()].some(k=>urlKeyPattern.test(k)))secretRejected();
   const fragment=boundedDecode(url.hash??'').replace(/^#/,'');for(const segment of fragment.split(/[&#]/)){const at=segment.indexOf('=');if(at>0&&urlKeyPattern.test(segment.slice(0,at)))secretRejected();}}
  }
 }else if(Array.isArray(x)){for(const v of x)visit(v);}else if(x&&typeof x==='object'){for(const v of Object.values(x))visit(v);}};
 visit(value);return value;
}
