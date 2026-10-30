'use strict';
const crypto = require('crypto');
const net = require('net');

module.exports = function registerVVBServers(app, db, requireUser) {
  const TTL = 30000;
  db.run(`CREATE TABLE IF NOT EXISTS vvb_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE, ip TEXT NOT NULL, port INTEGER NOT NULL,
    description TEXT NOT NULL DEFAULT '', max_players INTEGER NOT NULL DEFAULT 10,
    current_players INTEGER NOT NULL DEFAULT 0, last_ping INTEGER NOT NULL DEFAULT 0,
    token_hash TEXT NOT NULL, owner_id TEXT NOT NULL DEFAULT '', plugins TEXT NOT NULL DEFAULT '[]'
  )`);
  db.run("ALTER TABLE vvb_servers ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''",()=>{});
  const error = (res, code, message) => res.status(code).json({error:message});
  const digest = s => crypto.createHash('sha256').update(s).digest('hex');
  const equal = (a,b) => { const x=Buffer.from(a,'hex'), y=Buffer.from(b,'hex'); return x.length===y.length && crypto.timingSafeEqual(x,y); };
  app.get('/api/servers', (req,res) => db.all('SELECT id,name,ip,port,description,max_players,current_players,last_ping FROM vvb_servers ORDER BY id DESC', [], (err,rows) => {
    if(err) return error(res,500,'Ошибка базы данных');
    res.set('Cache-Control','no-store');
    res.json(rows.map(s => {const online=s.last_ping>0 && Date.now()-s.last_ping<TTL; return {...s,status:online?'ONLINE':'OFFLINE',current_players:online?s.current_players:0};}));
  }));
  app.post('/api/servers', requireUser, (req,res) => {
    const b=req.body||{};
    const name=String(b.name||'').trim(), ip=String(b.ip||'').trim(), description=String(b.description||'').trim();
    const port=Number(b.port), max=Number(b.max_players);
    if(name.length<2||name.length>60||description.length>250||ip.length>253||!net.isIP(ip)&&!(/^(?=.{1,253}$)[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(ip))||!Number.isInteger(port)||port<1024||port>65535||!Number.isInteger(max)||max<1||max>100) return error(res,400,'Проверьте название, IP, порт и лимит игроков');
    const token=crypto.randomBytes(32).toString('hex');
    const plugins=Array.isArray(b.plugins)?JSON.stringify(b.plugins.slice(0,30).map(String)): '[]';
    db.run('INSERT INTO vvb_servers(name,ip,port,description,max_players,token_hash,plugins,owner_id) VALUES(?,?,?,?,?,?,?,?)', [name,ip,port,description,max,digest(token),plugins,req.siteUser.google_id],function(err){
      if(err) return error(res,err.code==='SQLITE_CONSTRAINT'?409:500,err.code==='SQLITE_CONSTRAINT'?'Название уже занято':'Ошибка базы данных');
      res.status(201).json({success:true,id:this.lastID,heartbeat_token:token});
    });
  });
  app.get('/api/servers/mine',requireUser,(req,res)=>db.all('SELECT id,name,ip,port,description,max_players FROM vvb_servers WHERE owner_id=?',[req.siteUser.google_id],(err,rows)=>err?error(res,500,'Ошибка базы'):res.json(rows)));
  app.post('/api/servers/ping', (req,res) => {
    const b=req.body||{}, name=String(b.name||''), token=String(req.get('X-Server-Token')||b.token||'');
    const players=Number(b.current_players);
    if(!name||!token||!Number.isInteger(players)||players<0) return error(res,400,'Неверный heartbeat');
    db.get('SELECT id,token_hash,max_players FROM vvb_servers WHERE name=?',[name],(err,s)=>{
      if(err) return error(res,500,'Ошибка базы данных');
      if(!s||!equal(digest(token),s.token_hash)) return error(res,403,'Неверный токен сервера');
      if(players>s.max_players) return error(res,400,'Игроков больше лимита');
      db.run('UPDATE vvb_servers SET last_ping=?,current_players=? WHERE id=?',[Date.now(),players,s.id],err=>err?error(res,500,'Ошибка БД'):res.json({success:true}));
    });
  });
  app.get('/api/servers/:name/config',(req,res)=>db.get('SELECT plugins FROM vvb_servers WHERE name=?',[req.params.name],(err,row)=>{
    if(err) return error(res,500,'Ошибка базы данных');
    if(!row) return error(res,404,'Сервер не найден');
    let ids=[]; try{ids=JSON.parse(row.plugins||'[]')}catch{}
    if(!ids.length)return res.json([]);
    db.all(`SELECT title,py_file_url FROM plugins WHERE id IN (${ids.map(()=>'?').join(',')})`,ids,(err,rows)=>err?error(res,500,'Ошибка БД'):res.json(rows));
  }));
  app.post('/api/servers/console',(req,res)=>error(res,501,'Удалённая консоль отключена до безопасной авторизации владельца'));
};
