const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function route({ role = true, invalidToken = false, failRole = false, conflict = false } = {}) {
  const calls = [];
  const rows = { admin_roles: role ? [{ role_id: 1, user_id: 'admin' }] : [],
    account_deletion_requests: [{ id: '00000000-0000-4000-8000-000000000001', status: 'pending', metadata: { previous: 'kept' } }] };
  const client = { auth: { getUser: async () => ({ data: { user: invalidToken ? null : { id: 'admin' } }, error: null }) },
    from(table) {
      let payload;
      const filters = [];
      const q = {
        select() { return q; }, eq(k,v) { filters.push(row => row[k] === v); return q; },
        order() { return q; }, limit() { return q; }, range() { return q; },
        update(value) { payload = value; return q; },
        maybeSingle: async () => run(true), then(resolve,reject) { return Promise.resolve(run(false)).then(resolve,reject); },
      };
      function run(single) {
        calls.push({ table, payload });
        if (table === 'admin_roles' && failRole) return { data: null, error: new Error('unavailable') };
        let selected = rows[table].filter(row => filters.every(f => f(row)));
        if (payload && conflict) selected = [];
        else if (payload) selected.forEach(row => Object.assign(row,payload));
        return { data: single ? selected[0] || null : selected, error: null, count: selected.length };
      }
      return q;
    } };
  const exports = {};
  const file = path.resolve(__dirname,'../app/api/account-deletion/admin/route.ts');
  const js = ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(js,{exports,URL,process:{env:{}},require(name){
    if (name === '@supabase/supabase-js') return { createClient: () => client };
    if (name === 'next/server') return { NextResponse: { json: (body,opts={}) => ({ status:opts.status||200, body }) } };
    throw new Error(`Unexpected import ${name}`);
  }});
  const request = (body,query='') => ({ url:`https://fixture.invalid/api/account-deletion/admin${query}`, headers: new Headers({authorization:'Bearer fixture'}), json:async()=>body });
  return { ...exports, request, calls, rows };
}

test('missing or invalid bearer is rejected before listing requests', async () => {
  const r = route({invalidToken:true});
  assert.equal((await r.GET(r.request())).status,401);
  assert.equal(r.calls.length,0);
  assert.equal((await r.GET({ ...r.request(), headers:new Headers() })).status,401);
});

test('ordinary user and failed role check cannot access service-role data', async () => {
  for (const config of [{role:false},{failRole:true}]) {
    const r=route(config);
    assert.equal((await r.GET(r.request())).status,403);
    assert.equal(r.calls.some(call=>call.table==='account_deletion_requests'),false);
  }
});

test('admin pagination and status filters are validated', async () => {
  const r=route();
  for (const query of ['?limit=100000','?offset=-1','?status=invalid','?limit=NaN']) assert.equal((await r.GET(r.request(null,query))).status,400);
  assert.equal((await r.GET(r.request(null,'?status=all&limit=10'))).status,200);
});

test('manual completion is rejected without changing account status', async () => {
  const r=route();
  const result=await r.PATCH(r.request({request_id:r.rows.account_deletion_requests[0].id,action:'completed'}));
  assert.equal(result.status,409); assert.equal(r.rows.account_deletion_requests[0].status,'pending');
});

test('approval preserves metadata and does not claim deletion', async () => {
  const r=route();
  const result=await r.PATCH(r.request({request_id:r.rows.account_deletion_requests[0].id,action:'approved',notes:'Review done'}));
  assert.equal(result.status,200);
  assert.equal(r.rows.account_deletion_requests[0].metadata.previous,'kept');
  assert.match(result.body.message,/belum dihapus/);
});

test('concurrent status change returns conflict instead of false success', async () => {
  const r=route({conflict:true});
  assert.equal((await r.PATCH(r.request({request_id:r.rows.account_deletion_requests[0].id,action:'approved'}))).status,409);
});

test('ticket metadata edits preserve resolution time and reopening clears it', async () => {
  let payload;
  const client = { from() { const q = {
    update(value) { payload=value; return q; }, eq() { return q; }, select() { return q; },
    single:async()=>({data:{id:'ticket',...payload},error:null}),
  }; return q; } };
  const file=path.resolve(__dirname,'../src/lib/api/support.ts');
  const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};
  vm.runInNewContext(js,{exports,Date,console:{error(){}},require(name){
    if(name==='../supabase/client')return{getSupabaseBrowserClient:()=>client};
    throw new Error(`Unexpected import ${name}`);
  }});
  await exports.updateTicketStatus('ticket',{priority:'high'});
  assert.equal('resolved_at' in payload,false);
  await exports.updateTicketStatus('ticket',{admin_notes:'new notes'});
  assert.equal('resolved_at' in payload,false);
  await exports.updateTicketStatus('ticket',{status:'open'});
  assert.equal(payload.resolved_at,null);
});

test('dashboard middleware requires an admin role for authenticated users', async () => {
  const file=path.resolve(__dirname,'../../admin-dashboard/middleware.js');
  const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  for(const allowed of [false,true]){
    const exports={};
    const q={select(){return q;},eq(){return q;},limit:async()=>({data:allowed?[{role_id:1}]:[],error:null})};
    vm.runInNewContext(js,{exports,URL,require(name){
      if(name==='@/utils/supabase/server')return{createClient:()=>({auth:{getUser:async()=>({data:{user:{id:'ordinary'}},error:null})},from:()=>q})};
      if(name==='next/server')return{NextResponse:{next:()=>({next:true}),redirect:url=>({redirect:url.pathname})}};
      if(name==='next/headers')return{cookies:()=>({})};
      throw new Error(`Unexpected import ${name}`);
    }});
    const response=await exports.middleware({url:'https://fixture.invalid/overview',nextUrl:{pathname:'/overview'}});
    if(allowed)assert.equal(response.next,true);else assert.equal(response.redirect,'/sign-in');
  }
});
