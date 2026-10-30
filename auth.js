'use strict';
// Company 2010: password login + persistent server-side sessions.
// Uses the same SQLite database as the existing website, so existing profiles
// and server-owner IDs continue to work. Do not store passwords in localStorage.
const crypto = require('node:crypto');
const SESSION_COOKIE = 'company2010_session';
const SESSION_DAYS = 7;
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map();

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const run = (db, sql, values = []) => new Promise((resolve, reject) =>
  db.run(sql, values, function (error) { error ? reject(error) : resolve(this); }));
const get = (db, sql, values = []) => new Promise((resolve, reject) =>
  db.get(sql, values, (error, row) => error ? reject(error) : resolve(row)));
const fail = (res, code, message) => res.status(code).json({ success: false, error: message });
const publicUser = user => ({
  google_id: user.google_id,
  name: user.name || '',
  picture: user.picture || '',
  email: user.email || '',
  bio: user.bio || '',
  vk: user.vk || '',
  discord: user.discord || ''
});
const safeString = value => typeof value === 'string' ? value.trim() : '';
const cookieValue = req => {
  const match = String(req.headers.cookie || '').split(';').map(x => x.trim())
    .find(x => x.startsWith(SESSION_COOKIE + '='));
  const token = match ? match.slice(SESSION_COOKIE.length + 1) : '';
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
};
const cookieOptions = req => {
  const tls = req?.secure || req?.headers?.['x-forwarded-proto']?.split(',')[0]?.trim() === 'https';
  return `HttpOnly; SameSite=Lax; Path=/; ${tls ? 'Secure; ' : ''}`;
};
const limit = (req, res, next) => {
  const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  if (attempts.size > 3000) for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
  const item = attempts.get(key);
  if (item && item.until > now && item.count >= MAX_ATTEMPTS)
    return fail(res, 429, 'Слишком много попыток. Повторите через 15 минут.');
  if (!item || item.until <= now) attempts.set(key, {count: 1, until: now + WINDOW_MS});
  else item.count++;
  next();
};
const clearAttempts = req => attempts.delete(String(req.ip || req.socket?.remoteAddress || 'unknown'));
const sameOrigin = (req, res, next) => {
  const origin = req.get?.('Origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return fail(res, 403, 'Запрос с другого сайта запрещён');
    } catch { return fail(res, 403, 'Неверный Origin'); }
  }
  if (req.get?.('Sec-Fetch-Site') === 'cross-site') return fail(res, 403, 'Запрос с другого сайта запрещён');
  next();
};

module.exports = function registerAuth(app, db) {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS local_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      google_id TEXT NOT NULL UNIQUE)`);
    db.run(`CREATE TABLE IF NOT EXISTS site_sessions (
      token_hash TEXT PRIMARY KEY,
      google_id TEXT NOT NULL,
      expires INTEGER NOT NULL)`);
    db.run('CREATE INDEX IF NOT EXISTS site_sessions_user_idx ON site_sessions(google_id)');
  });

  async function session(req) {
    const token = cookieValue(req);
    if (!token) return null;
    const saved = await get(db,
      'SELECT google_id FROM site_sessions WHERE token_hash = ? AND expires > ?',
      [sha256(token), Date.now()]);
    if (!saved) return null;
    return (await get(db, 'SELECT * FROM users WHERE google_id = ?', [saved.google_id])) || null;
  }

  async function issue(res, googleId, req) {
    const token = crypto.randomBytes(32).toString('hex');
    await run(db, 'INSERT INTO site_sessions(token_hash,google_id,expires) VALUES(?,?,?)',
      [sha256(token), googleId, Date.now() + SESSION_DAYS * 86400000]);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieOptions(req)}Max-Age=${SESSION_DAYS * 86400}`);
    res.setHeader('Cache-Control', 'no-store');
  }

  app.post('/api/auth/register', sameOrigin, limit, async (req, res) => {
    const name = safeString(req.body?.name);
    const email = safeString(req.body?.email).toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (name.length < 2 || name.length > 40) return fail(res, 400, 'Никнейм: от 2 до 40 символов');
    if (email.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return fail(res, 400, 'Введите корректную электронную почту');
    if (password.length < 10 || password.length > 128)
      return fail(res, 400, 'Пароль должен содержать от 10 до 128 символов');

    try {
      const previous = await get(db, 'SELECT id FROM local_accounts WHERE email = ?', [email]);
      if (previous) return fail(res, 409, 'Эта почта уже зарегистрирована. Нажмите «Вход».');
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = await new Promise((resolve, reject) =>
        crypto.scrypt(password, salt, 64, (e, data) => e ? reject(e) : resolve(data.toString('hex'))));
      const id = 'local:' + crypto.randomUUID();
      await run(db, "INSERT INTO users(google_id,name,picture,bio,email,vk,discord) VALUES(?,?,?,'',?,'','')",
        [id, name, '', email]);
      try {
        await run(db, 'INSERT INTO local_accounts(email,name,salt,password_hash,google_id) VALUES(?,?,?,?,?)',
          [email, name, salt, passwordHash, id]);
      } catch (error) {
        await run(db, 'DELETE FROM users WHERE google_id = ?', [id]).catch(() => {});
        throw error;
      }
      await issue(res, id, req);
      clearAttempts(req);
      return res.status(201).json({success: true, user: publicUser(await get(db, 'SELECT * FROM users WHERE google_id=?', [id]))});
    } catch (error) {
      console.error('Registration error:', error);
      return fail(res, error.code?.startsWith('SQLITE_CONSTRAINT') ? 409 : 500,
        error.code?.startsWith('SQLITE_CONSTRAINT') ? 'Почта уже используется' : 'Ошибка сервера при регистрации. Проверьте Logs в Render.');
    }
  });

  app.post('/api/auth/signin', sameOrigin, limit, async (req, res) => {
    const email = safeString(req.body?.email).toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) return fail(res, 400, 'Введите почту и пароль');
    try {
      const account = await get(db, 'SELECT * FROM local_accounts WHERE email = ?', [email]);
      if (!account) return fail(res, 401, 'Неверная почта или пароль');
      const calculated = await new Promise((resolve, reject) =>
        crypto.scrypt(password, account.salt, 64, (e, data) => e ? reject(e) : resolve(data)));
      const stored = Buffer.from(account.password_hash, 'hex');
      if (stored.length !== calculated.length || !crypto.timingSafeEqual(stored, calculated))
        return fail(res, 401, 'Неверная почта или пароль');
      const user = await get(db, 'SELECT * FROM users WHERE google_id = ?', [account.google_id]);
      if (!user) return fail(res, 500, 'Профиль аккаунта не найден в базе данных');
      await issue(res, user.google_id, req);
      clearAttempts(req);
      return res.json({success: true, user: publicUser(user)});
    } catch (error) {
      console.error('Sign-in error:', error);
      return fail(res, 500, 'Ошибка сервера при входе. Проверьте Logs в Render.');
    }
  });

  app.get('/api/auth/me', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const user = await session(req);
      return res.json({success: true, user: user ? publicUser(user) : null});
    } catch (error) {
      console.error('Session error:', error);
      return fail(res, 500, 'Ошибка проверки сессии');
    }
  });

  app.post('/api/auth/logout', sameOrigin, async (req, res) => {
    try {
      const token = cookieValue(req);
      if (token) await run(db, 'DELETE FROM site_sessions WHERE token_hash = ?', [sha256(token)]);
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieOptions(req)}Max-Age=0`);
      res.set('Cache-Control', 'no-store');
      return res.json({success: true});
    } catch (error) {
      console.error('Logout error:', error);
      return fail(res, 500, 'Ошибка выхода');
    }
  });

  async function requireUser(req, res, next) {
    try {
      req.siteUser = await session(req);
      if (!req.siteUser) return fail(res, 401, 'Войдите в свой аккаунт');
      next();
    } catch (error) {
      console.error('Auth middleware error:', error);
      return fail(res, 500, 'Ошибка авторизации');
    }
  }

  return {requireUser, issue, publicUser};
};
