'use strict';

// Company 2010 / Very Very Blood: authenticated two-player server registry.
// The website never starts or stops a game process; it only stores metadata
// and accepts authenticated heartbeats from a running dedicated server.
const crypto = require('crypto');
const net = require('net');

module.exports = function registerVVBServers(app, db, requireUser) {
  const HEARTBEAT_TTL_MS = 30000;
  const MAX_SERVERS_PER_ACCOUNT = 10;
  const err = (res, code, message) => res.status(code).json({error: message});
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const tokenMatches = (token, expectedHex) => {
    if (!/^[a-f0-9]{64}$/.test(String(expectedHex || ''))) return false;
    const actual = Buffer.from(hash(String(token)), 'hex');
    const expected = Buffer.from(expectedHex, 'hex');
    return crypto.timingSafeEqual(actual, expected);
  };

  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS vvb_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      ip TEXT NOT NULL,
      port INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      max_players INTEGER NOT NULL DEFAULT 2,
      current_players INTEGER NOT NULL DEFAULT 0,
      last_ping INTEGER NOT NULL DEFAULT 0,
      token_hash TEXT NOT NULL,
      owner_id TEXT NOT NULL DEFAULT '',
      plugins TEXT NOT NULL DEFAULT '[]'
    )`);
    // Compatibility with the public-server database created in earlier versions.
    db.run("ALTER TABLE vvb_servers ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''", () => {});
    db.run('UPDATE vvb_servers SET max_players = 2 WHERE max_players != 2');
  });

  const isOnline = row => Boolean(row.last_ping > 0 && Date.now() - row.last_ping < HEARTBEAT_TTL_MS);
  const toPublic = row => ({
    id: row.id, name: row.name, ip: row.ip, port: row.port,
    description: row.description, max_players: 2,
    current_players: isOnline(row) ? row.current_players : 0,
    status: isOnline(row) ? 'ONLINE' : 'OFFLINE',
    last_ping: row.last_ping
  });
  const validAddress = ip => net.isIP(ip) === 4 || (
    ip.length <= 253 && /^(?=.{1,253}$)[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(ip)
  );
  const parseMetadata = input => {
    const b = input || {};
    const name = String(b.name || '').trim();
    const ip = String(b.ip || '').trim();
    const description = String(b.description || '').trim();
    const port = Number(b.port);
    const maxPlayers = Number(b.max_players);
    if (name.length < 2 || name.length > 60 || !validAddress(ip) ||
        description.length > 250 || !Number.isInteger(port) || port < 1024 ||
        port > 65535 || maxPlayers !== 2) return null;
    return {name, ip, port, description};
  };
  // Cookie sessions are used for owner actions, so deny cross-origin browser writes.
  const sameOrigin = (req, res, next) => {
    const origin = req.get('Origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) return err(res, 403, 'Чужой источник запроса');
      } catch (_) { return err(res, 403, 'Неверный Origin'); }
    }
    if (req.get('Sec-Fetch-Site') === 'cross-site') return err(res, 403, 'Чужой сайт');
    next();
  };
  const withOwner = (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return err(res, 400, 'Неверный номер сервера');
    db.get('SELECT * FROM vvb_servers WHERE id = ? AND owner_id = ?',
      [id, req.siteUser.google_id], (e, row) => {
        if (e) return err(res, 500, 'Ошибка базы данных');
        if (!row) return err(res, 404, 'Сервер не найден среди ваших серверов');
        req.ownedServer = row;
        next();
      });
  };

  // Public list: no passwords, session IDs or heartbeat tokens.
  app.get('/api/servers', (req, res) => {
    db.all('SELECT id,name,ip,port,description,max_players,current_players,last_ping FROM vvb_servers ORDER BY id DESC',
      [], (e, rows) => {
        if (e) return err(res, 500, 'Ошибка базы данных');
        res.set('Cache-Control', 'no-store');
        res.json(rows.map(toPublic));
      });
  });

  app.get('/api/servers/mine', requireUser, (req, res) => {
    db.all('SELECT id,name,ip,port,description,max_players,current_players,last_ping FROM vvb_servers WHERE owner_id = ? ORDER BY id DESC',
      [req.siteUser.google_id], (e, rows) => {
        if (e) return err(res, 500, 'Ошибка базы данных');
        res.set('Cache-Control', 'no-store');
        res.json(rows.map(toPublic));
      });
  });

  app.post('/api/servers', requireUser, sameOrigin, (req, res) => {
    const values = parseMetadata(req.body);
    if (!values) return err(res, 400, 'Проверьте имя, публичный IPv4/домен, порт и лимит 2 игрока');
    db.get('SELECT COUNT(*) AS n FROM vvb_servers WHERE owner_id = ?', [req.siteUser.google_id], (e, count) => {
      if (e) return err(res, 500, 'Ошибка базы данных');
      if (count.n >= MAX_SERVERS_PER_ACCOUNT) return err(res, 400, 'Не более 10 серверов на аккаунт');
      const token = crypto.randomBytes(32).toString('hex');
      db.run('INSERT INTO vvb_servers(name,ip,port,description,max_players,token_hash,owner_id) VALUES(?,?,?,?,?,?,?)',
        [values.name, values.ip, values.port, values.description, 2, hash(token), req.siteUser.google_id],
        function (e) {
          if (e) return err(res, e.code === 'SQLITE_CONSTRAINT' ? 409 : 500,
            e.code === 'SQLITE_CONSTRAINT' ? 'Такое название уже используется' : 'Ошибка базы данных');
          res.status(201).json({success: true, id: this.lastID, heartbeat_token: token});
        });
    });
  });

  // OWNER CONTROL PANEL: each route checks the account session AND ownership.
  app.get('/api/servers/manage/:id', requireUser, withOwner, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(toPublic(req.ownedServer));
  });

  app.patch('/api/servers/manage/:id', requireUser, sameOrigin, withOwner, (req, res) => {
    const values = parseMetadata(req.body);
    if (!values) return err(res, 400, 'Проверьте название, IP, порт, описание и лимит');
    const requiresRestart = values.name !== req.ownedServer.name || values.port !== req.ownedServer.port;
    db.run(`UPDATE vvb_servers SET name = ?, ip = ?, port = ?, description = ?,
      last_ping = CASE WHEN ? THEN 0 ELSE last_ping END,
      current_players = CASE WHEN ? THEN 0 ELSE current_players END
      WHERE id = ? AND owner_id = ?`,
      [values.name, values.ip, values.port, values.description,
        requiresRestart ? 1 : 0, requiresRestart ? 1 : 0,
        req.ownedServer.id, req.siteUser.google_id], function (e) {
        if (e) return err(res, e.code === 'SQLITE_CONSTRAINT' ? 409 : 500,
          e.code === 'SQLITE_CONSTRAINT' ? 'Название занято' : 'Ошибка базы данных');
        res.json({success: true, must_restart: requiresRestart,
          message: requiresRestart ? 'Название или порт изменены. Исправьте server_config.json и перезапустите игровой сервер.' : 'Настройки сохранены.'});
      });
  });

  app.post('/api/servers/manage/:id/rotate-token', requireUser, sameOrigin, withOwner, (req, res) => {
    const token = crypto.randomBytes(32).toString('hex');
    db.run('UPDATE vvb_servers SET token_hash = ?, last_ping = 0, current_players = 0 WHERE id = ? AND owner_id = ?',
      [hash(token), req.ownedServer.id, req.siteUser.google_id], e => {
        if (e) return err(res, 500, 'Не удалось заменить токен');
        res.set('Cache-Control', 'no-store');
        res.json({success: true, heartbeat_token: token,
          message: 'Прежний токен отменён. Скачайте конфигурацию и перезапустите игровой сервер.'});
      });
  });

  app.delete('/api/servers/manage/:id', requireUser, sameOrigin, withOwner, (req, res) => {
    db.run('DELETE FROM vvb_servers WHERE id = ? AND owner_id = ?',
      [req.ownedServer.id, req.siteUser.google_id], e => {
        if (e) return err(res, 500, 'Не удалось удалить сервер');
        res.json({success: true, message: 'Запись удалена с сайта. Игровой процесс на компьютере не остановлен.'});
      });
  });

  // Machine-to-machine heartbeat: uses its own per-server token, not a user cookie.
  app.post('/api/servers/ping', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const token = String(req.get('X-Server-Token') || '');
    const count = Number(b.current_players);
    if (!name || !token || !Number.isInteger(count) || count < 0 || count > 2) {
      return err(res, 400, 'Неверный heartbeat');
    }
    db.get('SELECT id,token_hash FROM vvb_servers WHERE name = ?', [name], (e, row) => {
      if (e) return err(res, 500, 'Ошибка базы данных');
      if (!row || !tokenMatches(token, row.token_hash)) return err(res, 403, 'Неверный токен или имя сервера');
      db.run('UPDATE vvb_servers SET last_ping = ?, current_players = ? WHERE id = ?',
        [Date.now(), count, row.id], e => e ? err(res, 500, 'Ошибка базы данных') : res.json({success: true}));
    });
  });

  app.post('/api/servers/stop', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const token = String(req.get('X-Server-Token') || '');
    if (!name || !token) return err(res, 400, 'Неверный запрос');
    db.get('SELECT id,token_hash FROM vvb_servers WHERE name = ?', [name], (e, row) => {
      if (e) return err(res, 500, 'Ошибка базы данных');
      if (!row || !tokenMatches(token, row.token_hash)) return err(res, 403, 'Неверный токен');
      db.run('UPDATE vvb_servers SET last_ping = 0, current_players = 0 WHERE id = ?',
        [row.id], e => e ? err(res, 500, 'Ошибка базы данных') : res.json({success: true}));
    });
  });

  // Legacy plugin listing kept for compatibility with the older game client.
  app.get('/api/servers/:name/config', (req, res) => {
    db.get('SELECT plugins FROM vvb_servers WHERE name = ?', [req.params.name], (e, row) => {
      if (e) return err(res, 500, 'Ошибка базы данных');
      if (!row) return err(res, 404, 'Сервер не найден');
      let ids = [];
      try { ids = JSON.parse(row.plugins || '[]'); } catch (_) {}
      ids = Array.isArray(ids) ? ids.filter(x => /^\d+$/.test(String(x))).slice(0, 30) : [];
      if (!ids.length) return res.json([]);
      db.all(`SELECT title,py_file_url FROM plugins WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids, (e, rows) => e ? err(res, 500, 'Ошибка базы данных') : res.json(rows));
    });
  });

  app.post('/api/servers/console', (_req, res) => err(res, 501,
    'Удалённая консоль недоступна: игровой сервер не поддерживает удалённые команды'));
};
