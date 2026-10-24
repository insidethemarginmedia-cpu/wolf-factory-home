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

const {verifyOpenRouterAuthentication}=await import('../scripts/private-controller-preflight.mjs');
test('provider authentication works without repository token and never generates',async()=>{
 let calls=0;
 const result=await verifyOpenRouterAuthentication({env:{OPENROUTER_API_KEY:'fixture-only'},fetchImpl:async(url,options)=>{
 calls++;assert.equal(url,'https://openrouter.ai/api/v1/key');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,'Bearer fixture-only');return {ok:true,json:async()=>({...key,data:{...key.data,label:'must-not-leak'}})};
 }});
 assert.equal(calls,1);assert.equal(result.authenticationVerified,true);assert.equal(result.inferencePerformed,false);assert.equal(result.economicAdmission,'PASS');assert.equal(JSON.stringify(result).includes('must-not-leak'),false);
});
test('provider diagnostic missing credential makes no requests',async()=>{
 const result=await verifyOpenRouterAuthentication({env:{},fetchImpl:async()=>{throw Error('unexpected');}});assert.equal(result.state,'BLOCKED');
});
test('authenticated key with unknown or nonzero limit never gains economic admission',async()=>{
 for(const limit of [null,undefined,100]){
 const result=await verifyOpenRouterAuthentication({env,fetchImpl:async()=>({ok:true,json:async()=>({data:{...key.data,limit}})})});assert.equal(result.economicAdmission,'NOT_VERIFIED');assert.equal(result.inferencePerformed,false);
 }
});
test('provider diagnostic sanitizes transport errors and rejects denied authentication',async()=>{
 await assert.rejects(verifyOpenRouterAuthentication({env,fetchImpl:async()=>{throw Error('sensitive');}}),{message:'OPENROUTER_AUTH_NETWORK_FAILED'});
 await assert.rejects(verifyOpenRouterAuthentication({env,fetchImpl:async()=>({ok:false})}),{message:'OPENROUTER_AUTH_HTTP_DENIED'});
});
test('provider diagnostic rejects malformed metadata',async()=>{
 await assert.rejects(verifyOpenRouterAuthentication({env,fetchImpl:async()=>({ok:true,json:async()=>({data:{}})})}),{message:'OPENROUTER_AUTH_RESPONSE_INVALID'});
});

test('economic diagnostic identifies unmet gates without disclosing metadata',async()=>{
 for(const [data,reason] of [[{...key.data,limit:null},'SPENDING_LIMIT_UNKNOWN'],[{...key.data,limit:5},'SPENDING_LIMIT_NOT_ZERO'],[{...key.data,byok_usage:undefined},'BYOK_USAGE_UNKNOWN'],[{...key.data,is_free_tier:false},'FREE_TIER_NOT_CONFIRMED']]){
 const result=await verifyOpenRouterAuthentication({env,fetchImpl:async()=>({ok:true,json:async()=>({data:{...data,label:'private-label',hash:'private-hash'}})})});
 assert.equal(result.economicAdmission,'NOT_VERIFIED');assert.ok(result.economicReasons.includes(reason));assert.equal(JSON.stringify(result).includes('private-'),false);
 }
});

test('preflight denied requests retain safe stage and HTTP status without response body',async()=>{
 for(const [index,stage] of [[0,'PRIVATE_REPOSITORY'],[1,'CANONICAL_REF'],[2,'PROVIDER_KEY'],[3,'MODEL_CATALOG']]){
 let calls=0;const values=[repo,ref,key,catalog];
 await assert.rejects(verifyPrivateControllerAccess({env,fetchImpl:async()=>{
 const current=calls++;return current===index?{ok:false,status:403,json:async()=>{throw Error('secret-body');}}:{ok:true,json:async()=>values[current]};
 }}),error=>error.message==='PREFLIGHT_HTTP_DENIED'&&error.stage===stage&&error.httpStatus===403&&!JSON.stringify(error).includes('secret-body'));
 assert.equal(calls,index+1);
 }
});

test('malformed repository credentials are rejected without network or disclosure',async()=>{
 for(const token of ['fixture\nvalue','fixture value','fixture☃']){
 let calls=0;
 await assert.rejects(verifyPrivateControllerAccess({env:{...env,WOLF_FACTORY_REPO_TOKEN:token},fetchImpl:async()=>{calls++;}}),error=>error.message==='SERVICE_CREDENTIAL_FORMAT_INVALID'&&error.stage==='PRIVATE_REPOSITORY'&&!JSON.stringify(error).includes(token));
 assert.equal(calls,0);
 }
});
