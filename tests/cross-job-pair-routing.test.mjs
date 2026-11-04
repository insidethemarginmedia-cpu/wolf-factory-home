// Eligibility regression only; no dispatch, credentials or external effects.
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../.github/workflows/private-controller-preflight.yml',import.meta.url),'utf8');
function job(name){return source.split('\n  '+name+':\n')[1]?.split(/\n  [a-z][a-z-]+:\n/)[0];}
function eligible(name,{event='workflow_dispatch',ref='fix/omega-acceptance-ready-20261028',actor='insidethemarginmedia-cpu',repo='insidethemarginmedia-cpu/wolf-factory-home',pair=true,night=false,integrated=false,runner=false}={}){
 const expr=job(name)?.match(/    if: ([\s\S]*?)\n    runs-on:/)?.[1];assert.ok(expr,name+' condition');
 const github={repository:repo,actor,event_name:event,ref:'refs/heads/'+ref},inputs={verify_cross_job_ab:pair,night_shift:night,execute_integrated:integrated,verify_runner_loss:runner,use_publication_deploy_key:true},needs=new Proxy({},{get:(_,key)=>({result:key==='runner-loss-prepare'?(runner?'success':'skipped'):key==='integrated-factory'?(pair?'success':'skipped'):'success',outputs:{ready:'false'}})});
 return new Function('github','inputs','needs','always','return ('+expr.replaceAll('factory-source-admission','factory_source_admission').replaceAll('security-tests','security_tests').replaceAll('night-shift-admission','night_shift_admission').replaceAll('runner-loss-prepare','runner_loss_prepare').replaceAll('integrated-factory','integrated_factory')+')')(github,inputs,needs,()=>true);
}
test('bounded cross-job input defaults false and is confined to manual PR branch',()=>{
 assert.match(source,/verify_cross_job_ab:\n[\s\S]*?default: false/);
 for(const name of ['integrated-factory','runner-loss-recover']){
  assert.equal(eligible(name),true,name);
  for(const bad of [{event:'schedule',ref:'main'},{ref:'main'},{actor:'other'},{repo:'other/repo'},{pair:false},{pair:true,night:true},{pair:true,runner:true},{pair:true,integrated:true}])assert.equal(eligible(name,bad),false,name+' '+JSON.stringify(bad));
 }
 assert.equal(eligible('runner-loss-prepare'),false);
});
test('Job A publishes durable NEXT_READY and Job B restores before automatic continuation',()=>{
 const a=job('integrated-factory'),b=job('runner-loss-recover');
 assert.match(a,/snapshot_sha: \$\{\{ steps\.cross_job_export\.outputs\.snapshot_sha \}\}/);
 assert.match(a,/wolf-cross-job-pair\.mjs export/);assert.match(a,/Destroy cross-job A database and worker state/);
 assert.match(b,/needs\.integrated-factory\.outputs\.snapshot_sha/);assert.match(b,/wolf-cross-job-pair\.mjs restore/);assert.match(b,/wolf-cross-job-pair\.mjs complete/);assert.match(b,/wolf-cross-job-pair\.mjs duplicate/);
 assert.match(b,/actions: read/);assert.match(b,/contents: write/);
});
test('fresh B selects its existing SSH transport before fetching the advanced private checkpoint',()=>{
 const b=job('runner-loss-recover'),select=b.split('    - name: Select existing authorized branch and Git publication transport\n')[1]?.split('    - name:')[0];assert.ok(select);
 const remote=select.indexOf('git remote set-url origin git@github.com:donraposo1-source/project-wolf.git'),fetch=select.indexOf('git fetch --unshallow --no-tags origin refs/heads/feat/factory-real-worker-m1-20261006');
 assert.ok(remote>=0&&fetch>remote,'the frozen runner has no persisted HTTPS credential');assert.ok(select.includes('git merge --ff-only --no-edit "$WOLF_FACTORY_EXPECTED_SHA"'));
});
test('post-recovery regression installs the existing Mastra lockfile dependencies in the fresh B runner',()=>{
 const post=job('runner-loss-recover').split('    - name: Verify tests and production build after recovered publication\n')[1];assert.ok(post);
 const install=post.indexOf('npm ci --ignore-scripts --no-audit --no-fund --prefix infra/worker-router/mastra-runtime');assert.ok(install>=0&&install<post.indexOf('npm test'));
});
