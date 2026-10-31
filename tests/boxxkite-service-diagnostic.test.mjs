import test from 'node:test';import assert from 'node:assert/strict';
import {diagnoseBoxxkiteService} from '../scripts/boxxkite-service-diagnostic.mjs';
import * as diagnostic from '../scripts/boxxkite-service-diagnostic.mjs';
const reconcileBoxxkiteCreate=(...args)=>{
 assert.equal(typeof diagnostic.reconcileBoxxkiteCreate,'function','read-only reconciliation is not implemented');
 return diagnostic.reconcileBoxxkiteCreate(...args);
};
test('missing service credential blocks before network or source loading',async()=>{
 let calls=0;const r=await diagnoseBoxxkiteService({env:{WOLF_FACTORY_REPO_TOKEN:'fixture'},fetchImpl:async()=>{calls++;},loadTransport:()=>{calls++;}});assert.equal(r.state,'BLOCKED');assert.deepEqual(r.missing,['BOXXKITE_API_KEY']);assert.equal(calls,0);
});
test('diagnostic returns only permitted evidence and never invokes execution',async()=>{
 const r=await diagnoseBoxxkiteService({env:{WOLF_FACTORY_REPO_TOKEN:'fixture',BOXXKITE_API_KEY:'fixture'},loadTransport:()=>({preflight:async()=>({state:'BOXXKITE_SERVICE_ACCESS_VERIFIED',authenticationVerified:true,capacityForOneBoundedSandbox:true,executionPerformed:false,email:'private-marker'})})});
 assert.equal(r.controllerMissionVerified,false);assert.equal(r.sandboxCreated,false);assert.equal(JSON.stringify(r).includes('private-marker'),false);
});
test('incomplete service receipts never pass',async()=>{
 await assert.rejects(diagnoseBoxxkiteService({env:{WOLF_FACTORY_REPO_TOKEN:'fixture',BOXXKITE_API_KEY:'fixture'},loadTransport:()=>({preflight:async()=>({state:'BOXXKITE_SERVICE_ACCESS_VERIFIED'})})}),/RECEIPT_INVALID/);
});

test('unknown create reconciliation is read-only, exact-label scoped and never authorizes replay',async()=>{
 const calls=[];
 const r=await reconcileBoxxkiteCreate({label:'OMEGA_B_41040712384',env:{BOXXKITE_API_KEY:'fixture'},fetchImpl:async(url,options)=>{
  calls.push({url,options});
  return new Response(JSON.stringify([{id:'session-exact',label:'OMEGA_B_41040712384',status:'active',created_at:'2026-10-30T10:32:25Z',privateValue:'must-not-escape'},{id:'other',label:'OMEGA_B_1',status:'active'}]));
 }});
 assert.equal(calls.length,1);assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.redirect,'error');
 assert.equal(calls[0].url,'https://api.boxxkite.com/v1/sandboxes?active_only=false');
 assert.equal(r.state,'MATCH_OBSERVED');assert.equal(r.matches.length,1);assert.equal(r.matches[0].id,'session-exact');
 assert.equal(r.automaticRetryAuthorized,false);assert.equal(r.sandboxCreated,false);assert.equal(JSON.stringify(r).includes('must-not-escape'),false);
});

test('an empty listing preserves uncertainty and never converts absence into permission to recreate',async()=>{
 const r=await reconcileBoxxkiteCreate({label:'OMEGA_B_41040712384',env:{BOXXKITE_API_KEY:'fixture'},fetchImpl:async()=>new Response('[]')});
 assert.equal(r.state,'NO_MATCH_OBSERVED');assert.equal(r.createOutcome,'UNKNOWN');assert.equal(r.automaticRetryAuthorized,false);
});

test('duplicate matching labels remain reconciliation-required',async()=>{
 const r=await reconcileBoxxkiteCreate({label:'OMEGA_B_41040712384',env:{BOXXKITE_API_KEY:'fixture'},fetchImpl:async()=>new Response(JSON.stringify([{id:'one',label:'OMEGA_B_41040712384',status:'active'},{id:'two',label:'OMEGA_B_41040712384',status:'active'}]))});
 assert.equal(r.state,'MULTIPLE_MATCHES');assert.equal(r.automaticRetryAuthorized,false);
});

test('invalid label and missing credential fail before provider IO',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;};
 for(const label of ['../escape','OMEGA_B_41040712384?token=leak','arbitrary-account'])await assert.rejects(reconcileBoxxkiteCreate({label,env:{BOXXKITE_API_KEY:'fixture'},fetchImpl}),/RECONCILE_SCOPE/);
 await assert.rejects(reconcileBoxxkiteCreate({label:'OMEGA_B_41040712384',env:{},fetchImpl}),/CREDENTIAL_REQUIRED/);
 assert.equal(calls,0);
});

test('HTTP errors and malformed listings never become a confirmed outcome',async()=>{
 for(const response of [new Response('secret',{status:503}),new Response('{}'),new Response(JSON.stringify([{id:'one',label:'OMEGA_B_41040712384',status:'unknown'}]))]){
  await assert.rejects(reconcileBoxxkiteCreate({label:'OMEGA_B_41040712384',env:{BOXXKITE_API_KEY:'fixture'},fetchImpl:async()=>response}),/RECONCILE_/);
 }
});

for(const [name,limit] of [['reconciliation',1048576],['private source',131072]]){
 test(name+' response stops reading beyond configured limit',async()=>{
  let cancelled=false;const body=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(limit+1));},cancel(){cancelled=true;}});
  const response=new Response(body);
  if(name==='reconciliation'){await assert.rejects(reconcileBoxxkiteCreate({label:'OMEGA_B_41040712384',env:{BOXXKITE_API_KEY:'fixture'},fetchImpl:async()=>response}),/RECONCILE_RESPONSE_INVALID/);}
  else{await assert.rejects(diagnoseBoxxkiteService({env:{WOLF_FACTORY_REPO_TOKEN:'fixture',BOXXKITE_API_KEY:'fixture'},fetchImpl:async()=>response}),/PRIVATE_SOURCE_RESPONSE_DENIED/);}
  assert.equal(cancelled,true);
 });
}

test('remote transport loader enforces a streaming byte limit before parsing or import',async()=>{
 let textCalls=0,reads=0,cancelled=0;
 const response={ok:true,text:async()=>{textCalls++;return '{}';},body:{getReader:()=>({read:async()=>{reads++;return {done:false,value:new Uint8Array(131073)};},cancel:()=>{cancelled++;}})}};
 await assert.rejects(diagnoseBoxxkiteService({env:{WOLF_FACTORY_REPO_TOKEN:'fixture',BOXXKITE_API_KEY:'fixture'},fetchImpl:async()=>response}),{message:'PRIVATE_SOURCE_RESPONSE_DENIED'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(textCalls,0);assert.equal(reads,1);assert.equal(cancelled,1);
});
