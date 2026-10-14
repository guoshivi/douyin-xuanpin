import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {handleRound} from '../src/browser/round.mjs';
const root=path.resolve('.');
async function fixture(name){const dir=path.join(root,'data','acceptance','phase2','repair',name);await fs.mkdir(dir,{recursive:true});return path.join(dir,'evidence.json')}
function adapter(){const calls=[];const page={goto:async u=>calls.push(['goto',u]),url:async()=> 'https://buyin.jinritemai.com/observed',title:async()=> 'T',snapshot:async()=> 'private snapshot'};const task={spaceId:172,ownership:'agent',page:()=>page,finish:async x=>calls.push(['finish',x]),handOff:async()=>calls.push(['handoff'])};return {calls,task,factory:async()=>task}}
test('repair fake adapter observes landed URL and writes 0600 evidence',async()=>{const a=adapter(),file=await fixture('inspect');await handleRound({run_id:'TEST',action:'inspect',url:'https://buyin.jinritemai.com/dashboard',output_file:file},{root,taskSpace:a.factory});const x=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(x.landed_url,'https://buyin.jinritemai.com/observed');assert.equal(x.snapshot,'private snapshot');assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.deepEqual(a.calls,[['goto','https://buyin.jinritemai.com/dashboard']])})
test('repair fake adapter calls finish and handoff',async()=>{const a=adapter();await handleRound({run_id:'TEST',space_id:172,action:'finish',keep:[]},{root,taskSpace:a.factory});assert.deepEqual(a.calls,[['finish',{keep:[]}]]) ;const b=adapter();await handleRound({run_id:'TEST',space_id:172,action:'handoff'},{root,taskSpace:b.factory});assert.deepEqual(b.calls,[['handoff']])})
test('repair no runtime and user ownership refuse actions',async()=>{await assert.rejects(()=>handleRound({action:'inspect',url:'https://buyin.jinritemai.com/x'},{root}),/EGO_RUNTIME_REQUIRED/);const a=adapter();a.task.ownership='user';await assert.rejects(()=>handleRound({action:'inspect',url:'https://buyin.jinritemai.com/x'},{root,taskSpace:a.factory}),/USER_OWNED/);assert.deepEqual(a.calls,[])})
