import test from 'node:test';
import assert from 'node:assert/strict';
import {readPrivateSourceJson} from '../scripts/private-source-response.mjs';

// Transport fixtures only: no external requests, private code, inference or publication.
test('bounded source parser accepts valid JSON at the exact byte limit', async () => {
  const raw = JSON.stringify({message:'Português 🐺'});
  assert.deepEqual(await readPrivateSourceJson(new Response(raw), {maxBytes:Buffer.byteLength(raw)}), JSON.parse(raw));
});

test('source parsing enforces actual bytes rather than Content-Length', async () => {
  await assert.rejects(readPrivateSourceJson(new Response(' '.repeat(128), {headers:{'content-length':'1'}}), {maxBytes:127}), {message:'PRIVATE_SOURCE_RESPONSE_TOO_LARGE'});
});

test('oversized chunk cancels without draining additional untrusted source', async () => {
  let reads=0, cancelled=0;
  const response={body:{getReader:()=>({read:async()=>{reads++;return {done:false,value:new Uint8Array(9)};},cancel:()=>{cancelled++;}})}};
  await assert.rejects(readPrivateSourceJson(response,{maxBytes:8}),{message:'PRIVATE_SOURCE_RESPONSE_TOO_LARGE'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,1);assert.equal(cancelled,1);
});

test('malformed JSON and invalid UTF-8 produce only a sanitized reason',async()=>{
  for(const raw of ['private-marker',new Uint8Array([0xff])])
    await assert.rejects(readPrivateSourceJson(new Response(raw),{maxBytes:64}),{message:'PRIVATE_SOURCE_RESPONSE_INVALID'});
});

test('non-cooperative read and cancellation cannot prevent timeout',async()=>{
  const response={body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:()=>new Promise(()=>{})})}};
  await assert.rejects(readPrivateSourceJson(response,{maxBytes:64,timeoutMs:20}),{message:'PRIVATE_SOURCE_RESPONSE_TIMEOUT'});
});

test('successful parsing does not await non-cooperative cancellation',async()=>{
  let n=0;
  const response={body:{getReader:()=>({read:async()=>++n===1?{done:false,value:Buffer.from('{}')}:{done:true},cancel:()=>new Promise(()=>{})})}};
  assert.deepEqual(await readPrivateSourceJson(response,{maxBytes:64,timeoutMs:20}),{});
});

test('invalid limits and missing streams fail closed',async()=>{
  for(const options of [{maxBytes:0},{maxBytes:1048577},{maxBytes:64,timeoutMs:0},{maxBytes:64,timeoutMs:20001}])
    await assert.rejects(readPrivateSourceJson({},options),{message:'PRIVATE_SOURCE_RESPONSE_LIMIT_INVALID'});
  await assert.rejects(readPrivateSourceJson({text:()=>{throw Error('must not read unbounded text');}},{maxBytes:64}),{message:'PRIVATE_SOURCE_RESPONSE_UNREADABLE'});
});

test('oversized or malformed length declarations deny and cancel before reading',async()=>{
 for(const declared of ['65','invalid','-1']){
  let reads=0,cancelled=0;
  const response={headers:new Headers({'content-length':declared}),body:{getReader:()=>({read:async()=>{reads++;},cancel:()=>{cancelled++;}})}};
  await assert.rejects(readPrivateSourceJson(response,{maxBytes:64}),{message:'PRIVATE_SOURCE_RESPONSE_TOO_LARGE'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,0);assert.equal(cancelled,1);
 }
});

test('stream chunks may split UTF-8 characters without corrupting source',async()=>{
 const raw=Buffer.from(JSON.stringify({text:'🐺'}));let i=0;
 const response={body:{getReader:()=>({read:async()=>i<raw.length?{done:false,value:raw.subarray(i,++i)}:{done:true},cancel:()=>{}})}};
 assert.deepEqual(await readPrivateSourceJson(response,{maxBytes:64}),{text:'🐺'});
});
