import readline from 'node:readline';
const rl=readline.createInterface({input:process.stdin});
for await (const line of rl){let q;try{q=JSON.parse(line)}catch{console.log('notice: not instruction');continue} if(q.delay_ms) await new Promise(r=>setTimeout(r,q.delay_ms)); console.log(JSON.stringify({type:'space',space_id:q.space_id||'fake-space',page_label:'p1'})); if(q.action==='inspect') console.log(JSON.stringify({type:'observation',status:'ok',space_id:q.space_id||'fake-space',page_label:'p1',commodity_id:q.commodity_id||null,evidence_path:q.output_file||null,observed_count:0}));}
