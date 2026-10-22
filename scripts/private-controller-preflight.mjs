import {pathToFileURL} from 'node:url';
const repository='donraposo1-source/project-wolf';
const branch='feat/factory-real-worker-m1-20261006';
export async function verifyPrivateControllerAccess({env=process.env,fetchImpl=globalThis.fetch}={}){
 const required=['OPENROUTER_API_KEY','WOLF_FACTORY_REPO_TOKEN'];
 const missing=required.filter(name=>typeof env[name]!=='string'||!env[name].trim());
 if(missing.length)return {state:'BLOCKED',reason:'SERVICE_CONFIGURATION_REQUIRED',missing,inferencePerformed:false,privateSourceFetched:false};
 async function get(url,token){
  let response;try{response=await fetchImpl(url,{headers:token?{authorization:'Bearer '+token,'user-agent':'WolfFactoryPreflight'}:{},signal:AbortSignal.timeout(20000)});}catch{throw Error('PREFLIGHT_NETWORK_FAILED');}
  if(!response.ok)throw Error('PREFLIGHT_HTTP_DENIED');
  try{return await response.json();}catch{throw Error('PREFLIGHT_RESPONSE_INVALID');}
 }
 const repo=await get('https://api.github.com/repos/'+repository,env.WOLF_FACTORY_REPO_TOKEN);
 if(repo.full_name!==repository||repo.private!==true)throw Error('PRIVATE_REPOSITORY_IDENTITY_REQUIRED');
 const ref=await get('https://api.github.com/repos/'+repository+'/git/ref/heads/'+branch,env.WOLF_FACTORY_REPO_TOKEN);
 if(ref.ref!=='refs/heads/'+branch||!/^[a-f0-9]{40}$/.test(ref.object?.sha||''))throw Error('CANONICAL_SOURCE_REF_REQUIRED');
 const key=await get('https://openrouter.ai/api/v1/key',env.OPENROUTER_API_KEY);
 if(key.data?.is_free_tier!==true||key.data?.limit!==0||key.data?.byok_usage!==0)throw Error('ZERO_SPENDING_SERVICE_KEY_REQUIRED');
 const catalog=await get('https://openrouter.ai/api/v1/models');
 const model=catalog.data?.find(item=>item.id==='recursive/flint-v1.0:free');
 if(model?.pricing?.prompt!=='0'||model?.pricing?.completion!=='0')throw Error('EXACT_FREE_MODEL_REQUIRED');
 return {state:'PREFLIGHT_VERIFIED',privateRepositoryAccess:true,canonicalRefVerified:true,model:model.id,inferencePerformed:false,privateSourceFetched:false,missionExecutionVerified:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const result=await verifyPrivateControllerAccess();console.log(JSON.stringify(result));if(result.state!=='PREFLIGHT_VERIFIED')process.exitCode=78;}
 catch{console.error('PREFLIGHT_FAILED: no credential or remote response content logged');process.exitCode=1;}
}
