import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyPrivateControllerAccess,verifyOpenRouterAuthentication} from './private-controller-preflight.mjs';
const repo='donraposo1-source/project-wolf';
const branch='feat/factory-real-worker-m1-20261006';
const files=['infra/worker-router/direct-openrouter-executor.mjs','infra/worker-router/engineering-model-policy.mjs'];
export async function qualifyExistingWorker({env=process.env,fetchImpl=globalThis.fetch,loadExecutor}={}){
 const auth=await verifyOpenRouterAuthentication({env,fetchImpl});
 if(auth.authenticationVerified!==true||auth.economicAdmission!=='PASS')throw Error('ECONOMIC_ADMISSION_REQUIRED');
 const preflight=await verifyPrivateControllerAccess({env,fetchImpl});
 if(preflight.state!=='PREFLIGHT_VERIFIED')throw Error('PRIVATE_PREFLIGHT_REQUIRED');
 let directory;
 try{
  if(!loadExecutor){
   async function get(url){
    const response=await fetchImpl(url,{method:'GET',headers:{authorization:'Bearer '+env.WOLF_FACTORY_REPO_TOKEN,'user-agent':'WolfFactoryQualification',accept:'application/vnd.github+json'},redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Error('PRIVATE_SOURCE_ACCESS_DENIED');
    const raw=await response.text();if(Buffer.byteLength(raw)>1048576)throw Error('PRIVATE_SOURCE_SIZE_DENIED');
    try{return JSON.parse(raw);}catch{throw Error('PRIVATE_SOURCE_RESPONSE_INVALID');}
   }
   const ref=await get('https://api.github.com/repos/'+repo+'/git/ref/heads/'+branch);
   const sha=ref.object?.sha;if(ref.ref!=='refs/heads/'+branch||!/^[a-f0-9]{40}$/.test(sha||''))throw Error('PRIVATE_SOURCE_REF_INVALID');
   directory=await mkdtemp(path.join(tmpdir(),'wolf-private-qualification-'));
   await mkdir(path.join(directory,'infra/worker-router'),{recursive:true});
   for(const file of files){
    const data=await get('https://api.github.com/repos/'+repo+'/contents/'+file+'?ref='+sha);
    if(data.path!==file||data.encoding!=='base64'||typeof data.content!=='string'||data.size>262144)throw Error('PRIVATE_SOURCE_RESPONSE_INVALID');
    const source=Buffer.from(data.content,'base64');if(!source.length||source.length>262144||source.length!==data.size)throw Error('PRIVATE_SOURCE_SIZE_DENIED');
    await writeFile(path.join(directory,file),source,{mode:0o600});
   }
   const adapter=await import(pathToFileURL(path.join(directory,files[0])).href);
   loadExecutor=()=>adapter.createDirectOpenRouterExecutor({apiKey:env.OPENROUTER_API_KEY,fetchImpl,timeoutMs:30000});
  }
  const execute=await loadExecutor();
  const receipt=await execute({model:'recursive/flint-v1.0:free',prompt:'Reply with exactly WOLF_RUNTIME_OK. Do not use tools.'});
  if(receipt.model!=='recursive/flint-v1.0:free'||receipt.costUsd!==0||typeof receipt.generationId!=='string'||!receipt.generationId.trim()||receipt.content?.trim()!=='WOLF_RUNTIME_OK')throw Error('WORKER_QUALIFICATION_RECEIPT_INVALID');
  return {state:'WORKER_INFERENCE_VERIFIED',model:receipt.model,generationId:receipt.generationId,costUsd:receipt.costUsd,output:'WOLF_RUNTIME_OK',inferencePerformed:true,controllerMissionVerified:false};
 }finally{if(directory)await rm(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(await qualifyExistingWorker()));}
 catch(error){const allowed=['ECONOMIC_ADMISSION_REQUIRED','PRIVATE_PREFLIGHT_REQUIRED','PRIVATE_SOURCE_ACCESS_DENIED','PRIVATE_SOURCE_REF_INVALID','PRIVATE_SOURCE_RESPONSE_INVALID','PRIVATE_SOURCE_SIZE_DENIED','WORKER_QUALIFICATION_RECEIPT_INVALID','EXACT_FREE_MODEL_UNAVAILABLE','EXACT_ZERO_COST_RECEIPT_REQUIRED','OPENROUTER_HTTP_401','OPENROUTER_HTTP_402','OPENROUTER_HTTP_404','OPENROUTER_HTTP_429','OPENROUTER_REQUEST_FAILED'];console.error(JSON.stringify({state:'BLOCKED',reason:allowed.includes(error?.message)?error.message:'WORKER_QUALIFICATION_FAILED',controllerMissionVerified:false}));process.exitCode=1;}
}
