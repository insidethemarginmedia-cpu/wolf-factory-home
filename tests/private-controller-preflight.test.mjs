import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyPrivateControllerAccess} from '../scripts/private-controller-preflight.mjs';
const model='recursive/flint-v1.0:free';
const repo={full_name:'donraposo1-source/project-wolf',private:true};
const ref={ref:'refs/heads/feat/factory-real-worker-m1-20261006',object:{sha:'a'.repeat(40)}};
const key={data:{is_free_tier:true,limit:0,byok_usage:0}};
const catalog={data:[{id:model,pricing:{prompt:'0',completion:'0'}}]};
const env={OPENROUTER_API_KEY:'fixture-provider',WOLF_FACTORY_REPO_TOKEN:'fixture-repository'};
function serve(values){let calls=0;return {fetchImpl:async()=>({ok:true,json:async()=>values[calls++]}),calls:()=>calls};}
test('missing credentials block before any network access',async()=>{
 let calls=0;const result=await verifyPrivateControllerAccess({env:{},fetchImpl:async()=>{calls++;}});
 assert.equal(result.state,'BLOCKED');assert.deepEqual(result.missing,['OPENROUTER_API_KEY','WOLF_FACTORY_REPO_TOKEN']);assert.equal(calls,0);
});
test('a public or different repository cannot pass private-source admission',async()=>{
 for(const bad of [{...repo,private:false},{...repo,full_name:'someone/else'}]){
  const s=serve([bad]);await assert.rejects(verifyPrivateControllerAccess({env,fetchImpl:s.fetchImpl}),/PRIVATE_REPOSITORY_IDENTITY_REQUIRED/);assert.equal(s.calls(),1);
 }
});
test('wrong source branch or malformed commit cannot pass',async()=>{
 for(const bad of [{...ref,ref:'refs/heads/main'},{...ref,object:{sha:'unknown'}}]){
  const s=serve([repo,bad]);await assert.rejects(verifyPrivateControllerAccess({env,fetchImpl:s.fetchImpl}),/CANONICAL_SOURCE_REF_REQUIRED/);assert.equal(s.calls(),2);
 }
});
test('nonzero, unknown and non-free service limits are rejected',async()=>{
 for(const bad of [{data:{...key.data,limit:1}},{data:{...key.data,limit:null}},{data:{...key.data,is_free_tier:false}},{data:{...key.data,byok_usage:1}}]){
  const s=serve([repo,ref,bad]);await assert.rejects(verifyPrivateControllerAccess({env,fetchImpl:s.fetchImpl}),/ZERO_SPENDING_SERVICE_KEY_REQUIRED/);
 }
});
test('exact free catalog identity is required',async()=>{
 for(const bad of [{data:[]},{data:[{id:model,pricing:{prompt:'1',completion:'0'}}]}]){
  const s=serve([repo,ref,key,bad]);await assert.rejects(verifyPrivateControllerAccess({env,fetchImpl:s.fetchImpl}),/EXACT_FREE_MODEL_REQUIRED/);
 }
});
test('successful preflight exposes no private source hash, key metadata or credentials',async()=>{
 const s=serve([repo,ref,key,catalog]);const result=await verifyPrivateControllerAccess({env,fetchImpl:s.fetchImpl});
 assert.equal(result.state,'PREFLIGHT_VERIFIED');assert.equal(result.inferencePerformed,false);assert.equal(result.privateSourceFetched,false);assert.equal(s.calls(),4);
 const printed=JSON.stringify(result);for(const value of [env.OPENROUTER_API_KEY,env.WOLF_FACTORY_REPO_TOKEN,ref.object.sha])assert.equal(printed.includes(value),false);
});
test('network exceptions cannot expose a credential marker',async()=>{
 const marker='fixture-sensitive-marker';await assert.rejects(verifyPrivateControllerAccess({env,fetchImpl:async()=>{throw Error(marker);}}),e=>e.message==='PREFLIGHT_NETWORK_FAILED'&&!e.message.includes(marker));
});
