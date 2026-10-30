 'use strict';
const crypto=require('crypto');
const cookieName='company2010_session';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,function(e){e?reject(e):resolve(this)}));
const get=(db,sql,args=[])=>new Promise((resolve,reject)=>db.get(sql,args,(e,r)=>e?reject(e):resolve(r)));
const publicUser=u=>({google_id:u.google_id,name:u.name,picture:u.picture||'',email:u.email||'',bio:u.bio||'',vk:u.vk||'',discord:u.discord||''});
module.exports=function auth(app,db){
 db.serialize(()=>{
  db.run(`CREATE TABLE IF NOT EXISTS local_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, google_id TEXT NOT NULL UNIQUE)`);
  db.run(`CREATE TABLE IF NOT EXISTS site_sessions (token_hash TEXT PRIMARY KEY, google_id TEXT NOT NULL, expires INTEGER NOT NULL)`);
 });
 const session=async(req)=>{
  const raw=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='));
  if(!raw)return null;
  const token=raw.slice(cookieName.length+1);if(!/^[a-f0-9]{64}$/.test(token))return null;
  const row=await get(db,'SELECT google_id FROM site_sessions WHERE token_hash=? AND expires>?',[hash(token),Date.now()]);
  return row?await get(db,'SELECT * FROM users WHERE google_id=?',[row.google_id]):null;
 };
 const issue=async(res,googleId)=>{
  const token=crypto.randomBytes(32).toString('hex');
  await run(db,'INSERT INTO site_sessions(token_hash,google_id,expires) VALUES(?,?,?)',[hash(token),googleId,Date.now()+7*86400000]);
  res.setHeader('Set-Cookie',`${cookieName}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`);
 };
 const fail=(res,code,error)=>res.status(code).json({error});
 app.post('/api/auth/register',async(req,res)=>{
  try{
   const name=String(req.body?.name||'').trim(),email=String(req.body?.email||'').trim().toLowerCase(),password=String(req.body?.password||'');
   if(name.length<2||name.length>40||!/^\S+@\S+\.\S+$/.test(email)||email.length>150||password.length<10||password.length>128)return fail(res,400,'Имя 2–40 символов, корректная почта, пароль 10–128 символов');
   const salt=crypto.randomBytes(16).toString('hex');
   const pw=await new Promise((ok,no)=>crypto.scrypt(password,salt,64,(e,b)=>e?no(e):ok(b.toString('hex'))));
   const id='local:'+crypto.randomUUID();
   await run(db,'INSERT INTO local_accounts(email,name,salt,password_hash,google_id) VALUES(?,?,?,?,?)',[email,name,salt,pw,id]);
   await run(db,"INSERT INTO users(google_id,name,picture,bio,email,vk,discord) VALUES(?,?,?,'',?,'','')",[id,name,'',email]);
   await issue(res,id);res.status(201).json({success:true,user:publicUser(await get(db,'SELECT * FROM users WHERE google_id=?',[id]))});
  }catch(e){fail(res,e.code==='SQLITE_CONSTRAINT'?409:500,e.code==='SQLITE_CONSTRAINT'?'Эта почта уже зарегистрирована':'Ошибка регистрации');}
 });
 app.post('/api/auth/signin',async(req,res)=>{
  try{
   const email=String(req.body?.email||'').trim().toLowerCase(),pw=String(req.body?.password||'');
   const account=await get(db,'SELECT * FROM local_accounts WHERE email=?',[email]);
   if(!account)return fail(res,401,'Неверная почта или пароль');
   const computed=await new Promise((ok,no)=>crypto.scrypt(pw,account.salt,64,(e,b)=>e?no(e):ok(b)));
   const expected=Buffer.from(account.password_hash,'hex');
   if(expected.length!==computed.length||!crypto.timingSafeEqual(expected,computed))return fail(res,401,'Неверная почта или пароль');
   await issue(res,account.google_id);res.json({success:true,user:publicUser(await get(db,'SELECT * FROM users WHERE google_id=?',[account.google_id]))});
  }catch(e){fail(res,500,'Ошибка входа');}
 });
 app.get('/api/auth/me',async(req,res)=>{try{const u=await session(req);res.set('Cache-Control','no-store');res.json({user:u?publicUser(u):null});}catch(e){fail(res,500,'Ошибка сессии');}});
 app.post('/api/auth/logout',async(req,res)=>{try{const raw=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='));if(raw)await run(db,'DELETE FROM site_sessions WHERE token_hash=?',[hash(raw.slice(cookieName.length+1))]);res.setHeader('Set-Cookie',`${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);res.json({success:true});}catch(e){fail(res,500,'Ошибка выхода');}});
 async function requireUser(req,res,next){try{req.siteUser=await session(req);if(!req.siteUser)return fail(res,401,'Войдите в аккаунт');next();}catch(e){fail(res,500,'Ошибка авторизации');}}
 return {requireUser,issue,publicUser};
};
