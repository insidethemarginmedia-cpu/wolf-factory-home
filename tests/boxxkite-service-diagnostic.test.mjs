import test from 'node:test';import assert from 'node:assert/strict';
import {diagnoseBoxxkiteService} from '../scripts/boxxkite-service-diagnostic.mjs';
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
