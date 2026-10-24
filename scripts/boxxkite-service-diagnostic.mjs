import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const repository='donraposo1-source/project-wolf',branch='feat/factory-real-worker-m1-20261006';
export async function diagnoseBoxxkiteService({env=process.env,fetchImpl=globalThis.fetch,loadTransport}={}){
 const missing=['WOLF_FACTORY_REPO_TOKEN','BOXXKITE_API_KEY'].filter(k=>typeof env[k]!=='string'||!env[k].trim());
 if(missing.length)return {state:'BLOCKED',reason:'SERVICE_CONFIGURATION_REQUIRED',missing,inferencePerformed:false,sandboxCreated:false};
 let directory;
 try{
  if(!loadTransport){
   async function get(route){
    const response=await fetchImpl('https://api.github.com/repos/'+repository+route,{method:'GET',headers:{authorization:'Bearer '+env.WOLF_FACTORY_REPO_TOKEN,'user-agent':'WolfFactoryServiceDiagnostic'},redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Error('PRIVATE_SOURCE_ACCESS_DENIED');
    const raw=await response.text();if(Buffer.byteLength(raw)>131072)throw Error('PRIVATE_SOURCE_RESPONSE_DENIED');
    try{return JSON.parse(raw)}catch{throw Error('PRIVATE_SOURCE_RESPONSE_DENIED')}
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
 try{const result=await diagnoseBoxxkiteService();console.log(JSON.stringify(result));if(result.state==='BLOCKED')process.exitCode=78;}
 catch(error){const allowed=['PRIVATE_SOURCE_ACCESS_DENIED','PRIVATE_SOURCE_RESPONSE_DENIED','SERVICE_DIAGNOSTIC_RECEIPT_INVALID','BOXXKITE_SERVICE_CREDENTIAL_REQUIRED','BOXXKITE_SERVICE_HTTP_DENIED','BOXXKITE_SERVICE_READ_FAILED','BOXXKITE_CAPACITY_UNKNOWN','BOXXKITE_CAPACITY_DENIED'];console.error(JSON.stringify({state:'BLOCKED',reason:allowed.includes(error?.message)?error.message:'SERVICE_DIAGNOSTIC_FAILED',httpStatus:Number.isInteger(error?.httpStatus)?error.httpStatus:0,inferencePerformed:false,sandboxCreated:false}));process.exitCode=1;}
}
