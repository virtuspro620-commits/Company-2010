'use strict';
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const dbNative = new DatabaseSync(':memory:');
const db = {
  serialize(fn) {fn();},
  run(sql, args, callback) {
    if (typeof args === 'function') {callback = args; args=[];}
    if (!args) args=[];
    try {
      const result=dbNative.prepare(sql).run(...args);
      if(callback)callback.call({lastID:Number(result.lastInsertRowid),changes:result.changes},null);
    } catch (e) {if(callback)callback(e); else throw e;}
  },
  get(sql,args,callback) {try{callback(null,dbNative.prepare(sql).get(...args));}catch(e){callback(e);}},
  all(sql,args,callback) {try{callback(null,dbNative.prepare(sql).all(...args));}catch(e){callback(e);}}
};
const routes = new Map();
const app={};
for(const method of ['get','post','patch','delete']) app[method]=(path,...middlewares)=>routes.set(method.toUpperCase()+' '+path,middlewares);
const requireUser = (req,res,next)=>req.siteUser?next():res.status(401).json({error:'login'});
require('./SITE/vvb_servers.js')(app,db,requireUser);
async function request(method,path,{user='alice',body={},token='',origin='https://example.com'}={}) {
  let match, handlers;
  for (const [key, funcs] of routes.entries()) {
    const [verb,template]=key.split(' ');
    if(verb!==method) continue;
    const pieces=template.split('/'), parts=path.split('/');
    if(pieces.length!==parts.length)continue;
    const params={};let good=true;
    pieces.forEach((p,i)=>{if(p.startsWith(':')) params[p.slice(1)]=parts[i];else if(p!==parts[i])good=false;});
    if(good){match=params;handlers=funcs;break;}
  }
  assert(handlers,'route '+method+' '+path);
  return await new Promise((resolve,reject)=>{
    const req={params:match,body,siteUser:user?{google_id:user}:null,
      get:(header)=>header.toLowerCase()==='x-server-token'?token:header.toLowerCase()==='origin'?origin:header.toLowerCase()==='host'?'example.com':''};
    const res={statusCode:200,status(n){this.statusCode=n;return this;},set(){return this;},
      json(data){resolve({status:this.statusCode,data});return this;}};
    let i=0;
    const next=()=>{try{handlers[i++](req,res,next);}catch(e){reject(e);}};
    next();
  });
}
(async()=>{
  const original = {name:'VVB Тест',ip:'127.0.0.1',port:5555,max_players:2,description:'Сервер'};
  let r=await request('POST','/api/servers',{body:original});
  assert.equal(r.status,201);
  const id=r.data.id, oldToken=r.data.heartbeat_token;
  assert.match(oldToken,/^[a-f0-9]{64}$/);
  r=await request('GET','/api/servers');
  assert.equal(r.data.length,1);assert.equal(r.data[0].current_players,0);
  assert(!JSON.stringify(r.data).includes(oldToken));
  r=await request('POST','/api/servers/ping',{body:{name:original.name,current_players:1},token:'wrong'});
  assert.equal(r.status,403);
  r=await request('POST','/api/servers/ping',{body:{name:original.name,current_players:2},token:oldToken});
  assert.equal(r.status,200);
  r=await request('GET','/api/servers');assert.equal(r.data[0].current_players,2);
  r=await request('GET',`/api/servers/manage/${id}`,{user:'bob'});assert.equal(r.status,404);
  r=await request('PATCH',`/api/servers/manage/${id}`,{user:'bob',body:original});assert.equal(r.status,404);
  r=await request('POST',`/api/servers/manage/${id}/rotate-token`,{user:'bob'});assert.equal(r.status,404);
  r=await request('DELETE',`/api/servers/manage/${id}`,{user:'bob'});assert.equal(r.status,404);
  r=await request('POST',`/api/servers/manage/${id}/rotate-token`,{user:'alice',origin:'https://attacker.example'});assert.equal(r.status,403);
  r=await request('POST',`/api/servers/manage/${id}/rotate-token`);
  assert.equal(r.status,200);
  const newToken=r.data.heartbeat_token;assert.notEqual(newToken,oldToken);
  r=await request('POST','/api/servers/ping',{body:{name:original.name,current_players:1},token:oldToken});assert.equal(r.status,403);
  r=await request('POST','/api/servers/ping',{body:{name:original.name,current_players:0},token:newToken});assert.equal(r.status,200);
  r=await request('PATCH',`/api/servers/manage/${id}`,{body:{...original,name:'VVB Ренейм',port:5556}});
  assert.equal(r.status,200);assert.equal(r.data.must_restart,true);
  r=await request('POST','/api/servers/ping',{body:{name:original.name,current_players:0},token:newToken});assert.equal(r.status,403);
  r=await request('POST','/api/servers/ping',{body:{name:'VVB Ренейм',current_players:1},token:newToken});assert.equal(r.status,200);
  r=await request('GET','/api/servers/mine',{user:'alice'});assert.equal(r.data.length,1);
  r=await request('GET','/api/servers/mine',{user:'bob'});assert.equal(r.data.length,0);
  r=await request('DELETE',`/api/servers/manage/${id}`);assert.equal(r.status,200);
  r=await request('GET','/api/servers');assert.equal(r.data.length,0);
  console.log('PASS: create, owner isolation, valid/invalid heartbeat, reset token, rename, CSRF, delete');
})().catch(e=>{console.error(e);process.exitCode=1;});
