import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

test('minimal promotion applies to the exact main caller and changes routing without expanding schedule or actor scope', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wolf-promotion-candidate-'));
  try{
    const proposal=JSON.parse(fs.readFileSync(new URL('../docs/checkpoints/omega/MAIN-SCHEDULER-PROMOTION-20261029.proposal.json',import.meta.url),'utf8'));
    const patch=new URL('../docs/checkpoints/omega/MAIN-SCHEDULER-PROMOTION-20261029.patch',import.meta.url);
    assert.equal(proposal.files.length,1);
    const entry=proposal.files[0], file=path.join(root,entry.path);
    const gitBlob=s=>crypto.createHash('sha1').update('blob '+Buffer.byteLength(s)+'\0').update(s).digest('hex');
    assert.equal(gitBlob(entry.beforeContent),entry.expectedBlob);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(patch)).digest('hex'),proposal.patchSha256);
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,entry.beforeContent);
    execFileSync('git',['apply','--check',patch.pathname],{cwd:root,stdio:'pipe'});
    execFileSync('git',['apply',patch.pathname],{cwd:root,stdio:'pipe'});
    const candidate=fs.readFileSync(file,'utf8');assert.equal(gitBlob(candidate),entry.candidateBlob);
    const route=candidate.match(/^    uses: (.+)@([a-f0-9]{40})$/m);
    assert.equal(route?.[2],proposal.reviewedControllerSha);
    assert.equal(candidate.match(/^      public_runtime_sha: ([a-f0-9]{40})$/m)?.[1],route[2]);
    assert.match(candidate,/^      actions: read$/m);
    assert.equal(candidate.split('jobs:')[0],entry.beforeContent.split('jobs:')[0]);
    const guard=candidate.match(/^    if: (.+)$/m)?.[1];
    assert.equal(guard,entry.beforeContent.match(/^    if: (.+)$/m)?.[1]);
    const enabled=github=>new Function('github','return ('+guard+');')(github);
    const trusted={repository:'insidethemarginmedia-cpu/wolf-factory-home',actor:'insidethemarginmedia-cpu',event:{repository:{private:false}}};
    assert.equal(enabled(trusted),true);
    for(const delta of [{actor:'outsider'},{repository:'outsider/fork'},{event:{repository:{private:true}}}])assert.equal(enabled({...trusted,...delta}),false);
    assert.deepEqual(fs.readdirSync(path.dirname(file)),['night-shift-wakeup.yml']);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
