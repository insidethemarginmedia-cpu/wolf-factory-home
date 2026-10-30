import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readPrivateSourceJson} from './private-source-response.mjs';
const repository='donraposo1-source/project-wolf',branch='feat/factory-real-worker-m1-20261006';
// Observation only: neither an empty listing nor a matching label permits replay.
export async function reconcileBoxxkiteCreate({label,env=process.env,fetchImpl=globalThis.fetch}={}){
 if(typeof label!=='string'||!/^OMEGA_[ABC]_[0-9]{1,20}$/.test(label))throw Error('RECONCILE_SCOPE_DENIED');
 if(typeof env.BOXXKITE_API_KEY!=='string'||!env.BOXXKITE_API_KEY.trim()||/[\r\n\0]/.test(env.BOXXKITE_API_KEY))throw Error('RECONCILE_CREDENTIAL_REQUIRED');
 let response;
 try{response=await fetchImpl('https://api.boxxkite.com/v1/sandboxes?active_only=false',{method:'GET',headers:{authorization:'Bearer '+env.BOXXKITE_API_KEY},redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw Error('RECONCILE_READ_UNAVAILABLE');}
 if(!response.ok)throw Error('RECONCILE_HTTP_DENIED');
 let entries;
 try{entries=await readPrivateSourceJson(response,{maxBytes:1048576});}catch{throw Error('RECONCILE_RESPONSE_INVALID');}
 if(!Array.isArray(entries)||entries.length>1000)throw Error('RECONCILE_RESPONSE_INVALID');
 const matches=entries.filter(x=>x?.label===label).map(x=>{
  if(typeof x.id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(x.id)||!['active','running','ready','creating','pending','destroyed','expired','failed','stopped'].includes(x.status))throw Error('RECONCILE_RESPONSE_INVALID');
  const result={id:x.id,label,status:x.status};
  if(x.created_at!==undefined){if(typeof x.created_at!=='string'||x.created_at.length>64||!Number.isFinite(Date.parse(x.created_at)))throw Error('RECONCILE_RESPONSE_INVALID');result.created_at=x.created_at;}
  return result;
 });
 return {state:matches.length===1?'MATCH_OBSERVED':matches.length?'MULTIPLE_MATCHES':'NO_MATCH_OBSERVED',label,matches,listingCount:entries.length,createOutcome:'UNKNOWN',automaticRetryAuthorized:false,inferencePerformed:false,sandboxCreated:false,mutationPerformed:false};
}
export async function diagnoseBoxxkiteService({env=process.env,fetchImpl=globalThis.fetch,loadTransport}={}){
 const missing=['WOLF_FACTORY_REPO_TOKEN','BOXXKITE_API_KEY'].filter(k=>typeof env[k]!=='string'||!env[k].trim());
 if(missing.length)return {state:'BLOCKED',reason:'SERVICE_CONFIGURATION_REQUIRED',missing,inferencePerformed:false,sandboxCreated:false};
 let directory;
 try{
  if(!loadTransport){
   async function get(route){
    const response=await fetchImpl('https://api.github.com/repos/'+repository+route,{method:'GET',headers:{authorization:'Bearer '+env.WOLF_FACTORY_REPO_TOKEN,'user-agent':'WolfFactoryServiceDiagnostic'},redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Error('PRIVATE_SOURCE_ACCESS_DENIED');
    try{return await readPrivateSourceJson(response,{maxBytes:131072});}
    catch{throw Error('PRIVATE_SOURCE_RESPONSE_DENIED');}
   }
   const ref=await get('/git/ref/heads/'+branch),sha=ref.object?.sha;
   if(ref.ref!=='refs/heads/'+branch||!/^[a-f0-9]{40}$/.test(sha||''))throw Error('PRIVATE_SOURCE_RESPONSE_DENIED');
   const file='infra/autonomy/boxxkite-service-transport.mjs';
   const record=await get('/contents/'+file+'?ref='+sha);
   if(record.path!==file||record.encoding!=='base64'||!Number.isInteger(record.size)||record.size<1||record.size>32768||typeof record.content!=='string')throw Error('PRIVATE_SOURCE_RESPONSE_DENIED');
   const source=Buffer.from(record.content,'base64');if(source.length!==record.size)throw Error('PRIVATE_SOURCE_RESPONSE_DENIED');
   directory=await mkdtemp(path.join(tmpdir(),'wolf-service-diagnostic-'));const local=path.join(directory,'transport.mjs');await writeFile(local,source,{mode:0o600});
   const module=await import(pathToFileURL(local).href);loadTransport=()=>module.createBoxxkiteServiceTransport({apiKey:env.BOXXKITE_API_KEY,fetchImpl});
  }
  const result=await (await loadTransport()).preflight();
  if(result?.state!=='BOXXKITE_SERVICE_ACCESS_VERIFIED'||result.authenticationVerified!==true||result.capacityForOneBoundedSandbox!==true||result.executionPerformed!==false)throw Error('SERVICE_DIAGNOSTIC_RECEIPT_INVALID');
  return {state:result.state,authenticationVerified:true,capacityForOneBoundedSandbox:true,inferencePerformed:false,sandboxCreated:false,controllerMissionVerified:false};
 }finally{if(directory)await rm(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const reconcile=process.argv.length===3&&process.argv[2]==='--reconcile-create';if(process.argv.length>2&&!reconcile)throw Error('RECONCILE_SCOPE_DENIED');const result=reconcile?await reconcileBoxxkiteCreate({label:process.env.WOLF_BOXXKITE_RECONCILE_LABEL}):await diagnoseBoxxkiteService();console.log(JSON.stringify(result));if(result.state==='BLOCKED')process.exitCode=78;}
 catch(error){const allowed=['RECONCILE_SCOPE_DENIED','RECONCILE_CREDENTIAL_REQUIRED','RECONCILE_READ_UNAVAILABLE','RECONCILE_HTTP_DENIED','RECONCILE_RESPONSE_INVALID','PRIVATE_SOURCE_ACCESS_DENIED','PRIVATE_SOURCE_RESPONSE_DENIED','SERVICE_DIAGNOSTIC_RECEIPT_INVALID','BOXXKITE_SERVICE_CREDENTIAL_REQUIRED','BOXXKITE_SERVICE_HTTP_DENIED','BOXXKITE_SERVICE_READ_FAILED','BOXXKITE_CAPACITY_UNKNOWN','BOXXKITE_CAPACITY_DENIED','BOXXKITE_FREE_PLAN_NOT_VERIFIED','BOXXKITE_HOSTED_BETA_PRICING_NOT_VERIFIED','BOXXKITE_HOSTED_BETA_SCOPE_NOT_VERIFIED'];console.error(JSON.stringify({state:'BLOCKED',reason:allowed.includes(error?.message)?error.message:'SERVICE_DIAGNOSTIC_FAILED',httpStatus:Number.isInteger(error?.httpStatus)?error.httpStatus:0,inferencePerformed:false,sandboxCreated:false}));process.exitCode=1;}
}
