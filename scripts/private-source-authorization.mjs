
export async function verifyPrivateSourceCheckout({env=process.env,fetchImpl=globalThis.fetch}={}){
 const required=['WOLF_FACTORY_REPO_TOKEN','WOLF_FACTORY_EXPECTED_SHA'];
 const missing=required.filter(k=>typeof env[k]!=='string'||!env[k]);
 if(missing.length)return {state:'BLOCKED',reason:'SOURCE_CHECKOUT_CONFIGURATION_REQUIRED',missing,privateSourceFetched:false};
 if(!/^[\x21-\x7e]+$/.test(env.WOLF_FACTORY_REPO_TOKEN)||!/^[a-f0-9]{40}$/.test(env.WOLF_FACTORY_EXPECTED_SHA))throw Error('SOURCE_CHECKOUT_CONFIGURATION_DENIED');
 const repo='donraposo1-source/project-wolf';
 const branch='feat/factory-real-worker-m1-20261006';
 let res;try{res=await fetchImpl(`https://api.github.com/repos/${repo}/git/ref/heads/${branch}`,{headers:{authorization:`Bearer ${env.WOLF_FACTORY_REPO_TOKEN}`,'user-agent':'WolfPrivateSourceCheckout'},redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw Error('PRIVATE_SOURCE_REF_NETWORK_FAILED');}
 if(!res.ok)throw Error('PRIVATE_SOURCE_REF_DENIED');
 let ref;try{ref=await res.json();}catch{throw Error('PRIVATE_SOURCE_REF_INVALID');}
 if(ref.ref!==`refs/heads/${branch}`||ref.object?.sha!==env.WOLF_FACTORY_EXPECTED_SHA)throw Error('PRIVATE_SOURCE_REF_MISMATCH');
 const archive=`https://api.github.com/repos/${repo}/tarball/${env.WOLF_FACTORY_EXPECTED_SHA}`;
 // Do not put credentials into git remotes, process arguments, or public logs.
 // GitHub Actions downloads privately through an authenticated fetch with redirects blocked.
 // The archive is never downloaded, unpacked or exported by this preflight.
 let archiveResponse;try{archiveResponse=await fetchImpl(archive,{headers:{authorization:`Bearer ${env.WOLF_FACTORY_REPO_TOKEN}`,'user-agent':'WolfPrivateSourceCheckout','accept':'application/vnd.github+json'},redirect:'manual',signal:AbortSignal.timeout(20000)});}catch{throw Error('PRIVATE_SOURCE_ARCHIVE_NETWORK_FAILED');}
 if(archiveResponse.status!==302)throw Error('PRIVATE_SOURCE_ARCHIVE_DENIED');
 return {state:'SOURCE_ACCESS_VERIFIED',sourceRefVerified:true,privateArchiveAuthorized:true,privateSourceFetched:false,missionExecutionVerified:false,publishingEnabled:false};
}

if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){try{const result=await verifyPrivateSourceCheckout();console.log(JSON.stringify(result));if(result.state!=='SOURCE_ACCESS_VERIFIED')process.exitCode=78;}catch(error){const allowed=['SOURCE_CHECKOUT_CONFIGURATION_DENIED','PRIVATE_SOURCE_REF_NETWORK_FAILED','PRIVATE_SOURCE_REF_DENIED','PRIVATE_SOURCE_REF_INVALID','PRIVATE_SOURCE_REF_MISMATCH','PRIVATE_SOURCE_ARCHIVE_NETWORK_FAILED','PRIVATE_SOURCE_ARCHIVE_DENIED'];console.error(JSON.stringify({state:'FAILED',reason:allowed.includes(error?.message)?error.message:'PRIVATE_SOURCE_AUTHORIZATION_FAILED'}));process.exitCode=1;}}
