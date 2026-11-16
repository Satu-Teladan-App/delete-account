const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

function worker({configured=true,fail=false}={}){
 const secret='fixture-secret-'.repeat(4);
 const env={PUSH_DISPATCH_SECRET:secret,...(configured?{
  PUSH_ENVIRONMENT:'development',PUSH_PROJECT_ID:'fixture-project',EXPO_PUSH_ACCESS_TOKEN:'fixture-expo',
  SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-service',
 }: {})};
 let handler;let calls=0;
 const file=path.resolve(__dirname,'../supabase/functions/push-dispatch/index.ts');
 const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(js,{exports:{},Request,Response,Deno:{env:{get:key=>env[key]},serve:fn=>{handler=fn;}},require(name){
  if(name==='npm:@supabase/supabase-js@2.90.1')return{createClient:()=>{calls++;return{};}};
  if(name==='./dispatch.mjs')return{dispatchPushBatch:async()=>{if(fail)throw new Error('private-token-and-provider-response');return{processed:1};}};
  throw new Error(name);
 }});
 return {run:(auth,method='POST')=>handler(new Request('https://fixture.invalid/worker',{method,headers:auth?{authorization:auth}:{}})),secret,calls:()=>calls};
}
test('worker rejects missing or incorrect scheduler authorization before database access',async()=>{
 const w=worker();assert.equal((await w.run()).status,401);assert.equal((await w.run('Bearer wrong')).status,401);assert.equal(w.calls(),0);
});
test('worker rejects unsupported methods',async()=>{
 const w=worker();assert.equal((await w.run(`Bearer ${w.secret}`,'GET')).status,405);assert.equal(w.calls(),0);
});
test('worker fails closed when required environment configuration is missing',async()=>{
 const w=worker({configured:false});assert.equal((await w.run(`Bearer ${w.secret}`)).status,503);assert.equal(w.calls(),0);
});
test('configured worker returns counts and hides provider errors',async()=>{
 const w=worker();assert.equal((await w.run(`Bearer ${w.secret}`)).status,200);assert.equal(w.calls(),1);
 const broken=worker({fail:true});const response=await broken.run(`Bearer ${broken.secret}`);assert.equal(response.status,500);assert.doesNotMatch(await response.text(),/private-token/);
});
