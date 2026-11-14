'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
test('missing, malformed, and out-of-range exit codes cannot become a pass',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evidence-exit-'));
  try {
    const out=path.join(dir,'.playwright-ai-router'); fs.mkdirSync(out);
    for(const value of ['', 'garbage', '-1', '256', '0']) {
      fs.writeFileSync(path.join(out,'exit-code'),value);
      const r=spawnSync(process.execPath,[path.resolve(__dirname,'../scripts/collect-evidence.js')],{cwd:dir,env:{PATH:process.env.PATH},encoding:'utf8'});
      assert.equal(r.status,0,r.stderr);
      assert.equal(JSON.parse(fs.readFileSync(path.join(out,'evidence.json'))).passed,value==='0');
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
