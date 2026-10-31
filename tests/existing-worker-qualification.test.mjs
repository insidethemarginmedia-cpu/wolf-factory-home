import test from 'node:test';
import assert from 'node:assert/strict';
import {qualifyExistingWorker} from '../scripts/existing-worker-qualification.mjs';
const env={OPENROUTER_API_KEY:'fixture-provider',WOLF_FACTORY_REPO_TOKEN:'fixture-github'};
const key={data:{is_free_tier:true,limit:0,byok_usage:0}};
const repo={full_name:'donraposo1-source/project-wolf',private:true};
const ref={ref:'refs/heads/feat/factory-real-worker-m1-20261006',object:{sha:'a'.repeat(40)}};
const catalog={data:[{id:'recursive/flint-v1.0:free',pricing:{prompt:'0',completion:'0'}}]};
const fetcher=values=>{let i=0;return async()=>({ok:true,json:async()=>values[i++]});};
test('economic denial prevents private source loading and inference',async()=>{
 let loaded=false;await assert.rejects(qualifyExistingWorker({env,fetchImpl:fetcher([{data:{...key.data,limit:null}}]),loadExecutor:()=>{loaded=true;}}),/ECONOMIC_ADMISSION_REQUIRED/);assert.equal(loaded,false);
});
test('existing adapter receives only exact authorized model and bounded diagnostic task',async()=>{
 let calls=0;const receipt=await qualifyExistingWorker({env,fetchImpl:fetcher([key,repo,ref,key,catalog]),loadExecutor:()=>async request=>{calls++;assert.equal(request.model,'recursive/flint-v1.0:free');return {model:request.model,costUsd:0,generationId:'fixture-generation',content:'WOLF_RUNTIME_OK',private:'must-not-leak'};}});
 assert.equal(calls,1);assert.equal(receipt.controllerMissionVerified,false);assert.equal(receipt.costUsd,0);assert.equal(JSON.stringify(receipt).includes('must-not-leak'),false);
});
test('paid, missing and wrong-content receipts are rejected',async()=>{
 for(const overrides of [{costUsd:1},{generationId:''},{content:'unexpected'},{model:'paid-model'}])await assert.rejects(qualifyExistingWorker({env,fetchImpl:fetcher([key,repo,ref,key,catalog]),loadExecutor:()=>async()=>({model:'recursive/flint-v1.0:free',costUsd:0,generationId:'fixture',content:'WOLF_RUNTIME_OK',...overrides})}),/WORKER_QUALIFICATION_RECEIPT_INVALID/);
});

test('private worker loader limits streamed bytes before dynamic import or inference',async()=>{
 let textCalls=0,reads=0,cancelled=0,n=0;
 const values=[key,repo,ref,key,catalog];
 const response={ok:true,text:async()=>{textCalls++;return '{}';},body:{getReader:()=>({read:async()=>{reads++;return {done:false,value:new Uint8Array(1048577)};},cancel:()=>{cancelled++;}})}};
 await assert.rejects(qualifyExistingWorker({env,fetchImpl:async()=>n<values.length?{ok:true,json:async()=>values[n++]}:response}),{message:'PRIVATE_SOURCE_SIZE_DENIED'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(textCalls,0);assert.equal(reads,1);assert.equal(cancelled,1);
});
