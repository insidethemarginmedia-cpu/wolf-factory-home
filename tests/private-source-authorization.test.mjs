import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyPrivateSourceCheckout} from '../scripts/private-source-authorization.mjs';
const sha='a'.repeat(40);
const env={WOLF_FACTORY_REPO_TOKEN:'fixture-token',WOLF_FACTORY_EXPECTED_SHA:sha};
const ref={ref:'refs/heads/feat/factory-real-worker-m1-20261006',object:{sha}};
test('missing token fails closed without IO',async()=>{let n=0;let r=await verifyPrivateSourceCheckout({env:{},fetchImpl:()=>{n++}});assert.equal(r.state,'BLOCKED');assert.equal(n,0)});
test('mismatched ref never accesses archive',async()=>{let n=0;await assert.rejects(verifyPrivateSourceCheckout({env,fetchImpl:async()=>{n++;return {ok:true,json:async()=>({...ref,object:{sha:'b'.repeat(40)}})}}}),/PRIVATE_SOURCE_REF_MISMATCH/);assert.equal(n,1)});
test('forbidden archive fails closed',async()=>{let n=0;await assert.rejects(verifyPrivateSourceCheckout({env,fetchImpl:async()=>{n++;return n===1?{ok:true,json:async()=>ref}:{status:403}}}),/PRIVATE_SOURCE_ARCHIVE_DENIED/);assert.equal(n,2)});
test('source access verified but no source retrieved or published',async()=>{let n=0;const r=await verifyPrivateSourceCheckout({env,fetchImpl:async(url,opts)=>{n++;assert.equal(opts.redirect,n===1?'error':'manual');return n===1?{ok:true,json:async()=>ref}:{status:302,headers:new Headers({location:`https://codeload.github.com/donraposo1-source/project-wolf/legacy.tar.gz/${sha}`})}}});assert.equal(r.state,'SOURCE_ACCESS_VERIFIED');assert.equal(r.privateSourceFetched,false);assert.equal(r.publishingEnabled,false);assert.equal(r.missionExecutionVerified,false);assert.ok(!JSON.stringify(r).includes(sha));assert.ok(!JSON.stringify(r).includes(env.WOLF_FACTORY_REPO_TOKEN));});

test('unexpected direct archive response denied',async()=>{let n=0;await assert.rejects(verifyPrivateSourceCheckout({env,fetchImpl:async()=>{n++;return n===1?{ok:true,json:async()=>ref}:{status:200}}}),/PRIVATE_SOURCE_ARCHIVE_DENIED/)});

test('archive redirect must match HTTPS codeload identity and exact pinned commit',async()=>{
 for(const location of [null,'https://attacker.example/archive',
  `http://codeload.github.com/donraposo1-source/project-wolf/legacy.tar.gz/${sha}`,
  `https://codeload.github.com.evil.example/donraposo1-source/project-wolf/legacy.tar.gz/${sha}`,
  `https://credential@codeload.github.com/donraposo1-source/project-wolf/legacy.tar.gz/${sha}`,
  `https://codeload.github.com/donraposo1-source/other/legacy.tar.gz/${sha}`,
  `https://codeload.github.com/donraposo1-source/project-wolf/legacy.tar.gz/${'b'.repeat(40)}`,
  `https://codeload.github.com/donraposo1-source/project-wolf/legacy.tar.gz/${sha}?redirect=private-marker`,
  `https://codeload.github.com/donraposo1-source/project-wolf/legacy.tar.gz/${sha}?token=one&token=two`,
  `https://codeload.github.com/donraposo1-source/project-wolf/legacy.tar.gz/${sha}?token=`,
  `https://codeload.github.com/donraposo1-source/project-wolf/legacy.tar.gz/${sha}?token=%0Aprivate-marker`,
  `https://codeload.github.com/donraposo1-source/project-wolf/legacy.tar.gz/${sha}#fragment`]){
  let calls=0;
  await assert.rejects(verifyPrivateSourceCheckout({env,fetchImpl:async()=>{
   calls++;return calls===1?{ok:true,json:async()=>ref}:{status:302,headers:new Headers(location===null?{}:{location})};
  }}),{message:'PRIVATE_SOURCE_ARCHIVE_REDIRECT_DENIED'});
  assert.equal(calls,2,'redirect must never be followed');
 }
});

test('exact pinned codeload destination permits a single opaque archive token without disclosure or follow',async()=>{
 let n=0;const token='opaque-github-archive-token';
 const result=await verifyPrivateSourceCheckout({env,fetchImpl:async()=>{
  n++;return n===1?{ok:true,json:async()=>ref}:{status:302,headers:new Headers({location:`https://codeload.github.com/donraposo1-source/project-wolf/legacy.tar.gz/${sha}?token=${token}`})};
 }});
 assert.equal(n,2);assert.equal(result.privateArchiveAuthorized,true);assert.equal(JSON.stringify(result).includes(token),false);
});
