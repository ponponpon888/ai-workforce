#!/usr/bin/env node
// Isolated inputs only: never executes SQL or any command passed to the hook.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url));
const ps=process.argv.includes('--target') && process.argv[process.argv.indexOf('--target')+1]==='ps';
const exe=ps ? (process.argv.includes('--pwsh') ? process.argv[process.argv.indexOf('--pwsh')+1] : 'pwsh') : process.execPath;
const hook=resolve(here,'../claude/hooks/guard-sql.'+(ps?'ps1':'mjs'));
const hookArgs=ps?['-NoProfile','-File',hook]:[hook];
const temp=mkdtempSync(join(tmpdir(),'aiwf-boundaries-'));
const approvals=join(temp,'approvals');mkdirSync(approvals);
const env={...process.env,AIWF_APPROVAL_DIR:approvals};
const payload=(text,shell=false)=>JSON.stringify({tool_name:shell?'Bash':'mcp__supabase__execute_sql',tool_input:shell?{command:text}:{query:text},cwd:temp});
const call=(text,shell=false)=>spawnSync(exe,hookArgs,{input:payload(text,shell),encoding:'utf8',env}).status;
const token=(sql)=>{const path=join(approvals,createHash('sha256').update('aiwf-exact-v2\0'+sql).digest('hex')+'.approval');writeFileSync(path,sql);return path;};
let pass=0,fail=0;
function check(name,fn){try{fn();pass++;console.log('PASS '+name);}catch(e){fail++;console.log('FAIL '+name+': '+e.message);}}
function approve(sql){const path=resolve(here,'approve-ddl.'+(ps?'ps1':'mjs'));const args=ps?['-NoProfile','-File',path,'-Sql',sql,'-Force']:[path,'--force',sql];const r=spawnSync(exe,args,{encoding:'utf8',env});assert.equal(r.status,0,r.stderr);}
try{
 check('unfiltered outer UPDATE with filtered subquery',()=>assert.equal(call('UPDATE t SET n=(SELECT n FROM s WHERE id=1)'),2));
 check('outer WHERE still allows UPDATE',()=>assert.equal(call('UPDATE t SET n=(SELECT n FROM s WHERE id=1) WHERE id=2'),0));
 check('CTE WHERE does not protect unfiltered UPDATE',()=>assert.equal(call('WITH s AS (SELECT n FROM q WHERE id=1) UPDATE t SET n=0'),2));
 check('CTE destructive DELETE cannot borrow outer WHERE',()=>assert.equal(call('WITH s AS (DELETE FROM t RETURNING id) SELECT * FROM s WHERE id=1'),2));
 check('filtered CTE DELETE remains allowed',()=>assert.equal(call('WITH s AS (DELETE FROM t WHERE id=1 RETURNING id) SELECT * FROM s'),0));
 check('DO is unsupported even when body was neutralized',()=>assert.equal(call('DO $$ BEGIN DELETE FROM t; END $$;'),2));
 check('DO word inside literal is harmless',()=>assert.equal(call("SELECT 'DO $$ DELETE FROM t $$'"),0));
 writeFileSync(join(temp,'safe.sql'),'SELECT 1;');writeFileSync(join(temp,'wrapper.sql'),'\\i leaf.sql\n');
 check('nested includes stop as unsupported',()=>assert.equal(call('psql -f wrapper.sql',true),2));
 check('partially unreadable files stop',()=>assert.equal(call('psql -f safe.sql -f missing.sql',true),2));
 const ddl="CREATE TABLE t (v text DEFAULT 'a  b')";
 approve(ddl);
 check('quoted whitespace changes invalidate approval',()=>assert.equal(call("CREATE TABLE t (v text DEFAULT 'a b')"),2));
 check('unchanged approved bytes pass',()=>assert.equal(call(ddl),0));
 check('exact approval consumed',()=>assert.equal(call(ddl),2));
 const fileCommand='psql -f ddl.sql';writeFileSync(join(temp,'ddl.sql'),'CREATE TABLE t (id int);');approve(fileCommand);
 check('file DDL cannot use command-only approval',()=>assert.equal(call(fileCommand,true),2));
 check('malformed JSON stops',()=>assert.equal(spawnSync(exe,hookArgs,{input:'{',encoding:'utf8',env}).status,2));
 const stale='CREATE TABLE stale (id int)';const p=token(stale);utimesSync(p,new Date(0),new Date(0));
 check('expired token stops',()=>assert.equal(call(stale),2));
 const future='CREATE TABLE future (id int)';const f=token(future);utimesSync(f,new Date(Date.now()+3600000),new Date(Date.now()+3600000));
 check('future dated token stops',()=>assert.equal(call(future),2));
 const invalid='CREATE TABLE invalid (id int)';writeFileSync(token(invalid),'different SQL');
 check('token content must match',()=>assert.equal(call(invalid),2));
 const concurrent='CREATE TABLE concurrent (id int)';approve(concurrent);
 const results=await Promise.all(Array.from({length:6},()=>new Promise(resolve=>{const c=spawn(exe,hookArgs,{env,stdio:['pipe','ignore','ignore']});c.on('error',()=>resolve(-1));c.on('close',resolve);c.stdin.on('error',()=>{});c.stdin.end(payload(concurrent));})));
 check('only one concurrent call consumes approval',()=>{assert.equal(results.filter(x=>x===0).length,1);assert.equal(results.filter(x=>x===2).length,5);});
 console.log(`pass: ${pass} fail: ${fail}`);process.exitCode=fail?1:0;
}finally{rmSync(temp,{recursive:true,force:true});}
