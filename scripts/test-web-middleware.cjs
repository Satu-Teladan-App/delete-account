const { readFileSync } = require('node:fs');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NextRequest } = require('next/server');
const ts = require('typescript');
const path = require('node:path');
const file = path.resolve('middleware.ts');
const mod = new Module(file, module);
mod.filename = file;
mod.paths = module.paths;
mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, file);
const run = (route, options) => mod.exports.middleware(new NextRequest(`https://example.com${route}`, options));
test('public deletion information and login remain accessible', () => {
  for (const route of ['/', '/hapusakun', '/hapus-akun', '/auth/login', '/privacy', '/tos']) {
    const r = run(route);
    assert.equal(r.headers.get('x-middleware-next'), '1');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
  }
});
test('retired pages redirect and retired APIs cannot execute', () => {
  for (const route of ['/tickets', '/auth/register', '/admin/deletion-requests']) assert.equal(new URL(run(route).headers.get('location')).pathname, '/hapusakun');
  for (const route of ['/api/auth/register', '/api/account-deletion/admin']) assert.equal(run(route, { method: 'POST' }).status, 404);
});
test('deletion API rejects absent or malformed authorization', () => {
  for (const authorization of ['', 'Bearer', 'Basic abc']) assert.equal(run('/api/account-deletion/request', { headers: { authorization } }).status, 401);
});
test('API restricts methods and cross-site writes, lets handler verify tokens', () => {
  assert.equal(run('/api/account-deletion/request', { method: 'DELETE' }).status, 405);
  assert.equal(run('/api/account-deletion/request', { method: 'POST', headers: { authorization: 'Bearer fixture', 'sec-fetch-site': 'cross-site' } }).status, 403);
  assert.equal(run('/api/account-deletion/request', { method: 'POST', headers: { authorization: 'Bearer fixture' } }).headers.get('x-middleware-next'), '1');
});
