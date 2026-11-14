'use strict';
// Real Chromium, local fixture, synthetic provider responses. No live model,
// customer application, external credentials, generated code or git writeback.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
function run(file, args, cwd, extra = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, {cwd, env: {PATH: process.env.PATH, HOME: process.env.HOME, ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH} : {}), CI: '1', ...extra}});
    let output = '';
    p.stdout.on('data', x => output += x); p.stderr.on('data', x => output += x);
    p.on('error', reject); p.on('close', status => resolve({status, output}));
  });
}

test('real Chromium failure -> evidence -> schema escalation -> report -> corrected assertion passes', {timeout: 90000}, async () => {
  const dir = fs.mkdtempSync(path.join(repo, '.browser-fixture-'));
  let calls = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', x => body += x);
    req.on('end', () => {
      calls.push(JSON.parse(body).model);
      const content = calls.length === 1 ? '{"confidence":0.99}' : JSON.stringify({summary:'Expected text differs from fixture', verdict:'fail', confidence:0.9, needs_visual_review:false,
        failures:[{test:'checkout', likely_cause:'wrong expected label', suggested_fix:'expect Ready'}]});
      res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({choices:[{message:{content}}]}));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    fs.writeFileSync(path.join(dir, 'playwright.config.js'), `module.exports={testDir:'.',outputDir:require('node:path').join(__dirname,'test-results'),testMatch:'fixture.spec.js',workers:1,retries:0,timeout:10000,use:{headless:true,screenshot:'only-on-failure',launchOptions:{args:['--no-sandbox']}},reporter:'list'};`);
    const spec = expected => `const {test,expect}=require('@playwright/test'); test('checkout',async({page})=>{await page.setContent('<button>Ready</button>'); await expect(page.getByRole('button')).toHaveText('${expected}',{timeout:500});});`;
    fs.writeFileSync(path.join(dir, 'fixture.spec.js'), spec('Wrong'));
    const command = `${process.execPath} ${path.join(repo,'node_modules/@playwright/test/cli.js')} test`;
    const failed = await run('bash',[path.join(repo,'scripts/run-tests.sh')],dir,{TEST_COMMAND:command});
    assert.equal(failed.status,0,failed.output); // wrapper deliberately defers failure
    assert.equal(fs.readFileSync(path.join(dir,'.playwright-ai-router/exit-code'),'utf8'),'1');
    assert.equal((await run(process.execPath,[path.join(repo,'scripts/collect-evidence.js')],dir)).status,0);
    const evidence=JSON.parse(fs.readFileSync(path.join(dir,'.playwright-ai-router/evidence.json')));
    assert.equal(evidence.passed,false); assert.ok(evidence.failed_tests.length>0); assert.ok(evidence.artifact_counts.screenshots>0, failed.output);
    const ai=await run(process.execPath,[path.join(repo,'scripts/route-ai.js')],dir,{API_KEY:'synthetic',BASE_URL:`http://127.0.0.1:${server.address().port}`,FAST_MODEL:'mock-fast',SMART_MODEL:'mock-smart'});
    assert.equal(ai.status,0,ai.output); assert.deepEqual(calls,['mock-fast','mock-smart']);
    const analysis=JSON.parse(fs.readFileSync(path.join(dir,'.playwright-ai-router/ai-response.json')));
    assert.equal(analysis.escalated,true); assert.equal(analysis.parsed.verdict,'fail');
    assert.equal((await run(process.execPath,[path.join(repo,'scripts/build-html-report.js')],dir)).status,0);
    assert.match(fs.readFileSync(path.join(dir,'playwright-ai-router-report.html'),'utf8'),/Expected text differs/);
    fs.writeFileSync(path.join(dir,'fixture.spec.js'),spec('Ready'));
    await run('bash',[path.join(repo,'scripts/run-tests.sh')],dir,{TEST_COMMAND:command});
    assert.equal(fs.readFileSync(path.join(dir,'.playwright-ai-router/exit-code'),'utf8'),'0');
  } finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); fs.rmSync(dir,{recursive:true,force:true}); }
});
