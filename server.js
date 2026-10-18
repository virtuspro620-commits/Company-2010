const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { OAuth2Client } = require('google-auth-library');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID = '457542589559-ngi47p1c12cbl2eid6u1epcdi2trcf7g.apps.googleusercontent.com';
const client = new OAuth2Client(CLIENT_ID);

// Загрузка файлов
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let dir = './uploads';
        if (file.fieldname === 'py_file') dir = './addons_files';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage: storage });

app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static('uploads'));
app.use('/addons_files', express.static('addons_files'));

const db = new sqlite3.Database('./database.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (google_id TEXT UNIQUE, name TEXT, picture TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS guestbook (id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS addons (id INTEGER PRIMARY KEY AUTOINCREMENT, author_name TEXT, title TEXT, description TEXT, cover_url TEXT, py_file_url TEXT, downloads INTEGER DEFAULT 0)`);
    // Добавляем поле last_ping для отслеживания реального онлайна
    db.run(`CREATE TABLE IF NOT EXISTS servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, map TEXT, max_players INTEGER, is_vip INTEGER DEFAULT 0, owner TEXT, last_ping INTEGER DEFAULT 0)`);
});

// Вход
app.post('/api/login', async (req, res) => {
    try {
        const ticket = await client.verifyIdToken({ idToken: req.body.token, audience: CLIENT_ID });
        const payload = ticket.getPayload();
        db.get(`SELECT * FROM users WHERE google_id = ?`, [payload.sub], (err, row) => {
            if (row) res.json({ success: true, user: { google_id: row.google_id, name: row.name, picture: row.picture } });
            else {
                db.run(`INSERT INTO users (google_id, name, picture) VALUES (?, ?, ?)`, [payload.sub, payload.given_name, payload.picture], () => {
                    res.json({ success: true, user: { google_id: payload.sub, name: payload.given_name, picture: payload.picture } });
                });
            }
        });
    } catch (e) { res.status(401).json({ error: 'Auth failed' }); }
});

// Профиль
app.post('/api/update-profile', upload.single('avatar'), (req, res) => {
    const { google_id, new_name } = req.body;
    const new_pic = req.file ? `/uploads/${req.file.filename}` : null;
    if (new_pic) db.run(`UPDATE users SET name = ?, picture = ? WHERE google_id = ?`, [new_name, new_pic, google_id], () => res.json({ success: true, name: new_name, picture: new_pic }));
    else db.run(`UPDATE users SET name = ? WHERE google_id = ?`, [new_name, google_id], () => res.json({ success: true, name: new_name, picture: null }));
});

// Гостевая
app.get('/api/guestbook', (req, res) => db.all(`SELECT * FROM guestbook ORDER BY id DESC`, [], (e, r) => res.json(r)));
app.post('/api/guestbook', (req, res) => db.run(`INSERT INTO guestbook (user_name, message) VALUES (?, ?)`, [req.body.name, req.body.message], () => res.json({ success: true })));

// Аддоны
app.get('/api/addons', (req, res) => db.all(`SELECT * FROM addons ORDER BY id DESC`, [], (e, r) => res.json(r)));
app.post('/api/addons/upload', upload.fields([{ name: 'cover', maxCount: 1 }, { name: 'py_file', maxCount: 1 }]), (req, res) => {
    const { author, title, desc } = req.body;
    const cover_url = req.files['cover'] ? `/uploads/${req.files['cover'][0].filename}` : '/resources/images/banner-bg.jpg';
    const py_file_url = req.files['py_file'] ? `/addons_files/${req.files['py_file'][0].filename}` : null;

    db.run(`INSERT INTO addons (author_name, title, description, cover_url, py_file_url) VALUES (?, ?, ?, ?, ?)`, 
        [author, title, desc, cover_url, py_file_url], 
        (err) => { if (err) return res.status(500).json({error: err.message}); res.json({ success: true }); }
    );
});
app.post('/api/addons/:id/download', (req, res) => {
    db.run(`UPDATE addons SET downloads = downloads + 1 WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

// СЕРВЕРА (Реальный онлайн)
app.get('/api/servers', (req, res) => {
    const now = Date.now();
    // Сервер считается онлайн, если от него был пинг менее 15 секунд назад
    db.all(`SELECT * FROM servers`, [], (e, rows) => {
        if (e) return res.json([]);
        const result = rows.map(s => {
            const isOnline = (now - s.last_ping) < 15000; 
            return {
                ...s,
                current_players: isOnline ? 1 : 0, // Показываем 1 игрока, если сервер онлайн
                status: isOnline ? 'ONLINE' : 'OFFLINE'
            };
        });
        res.json(result);
    });
});

app.post('/api/servers', (req, res) => {
    const { name, map, is_vip, owner } = req.body;
    db.run(`INSERT INTO servers (name, map, max_players, is_vip, owner, last_ping) VALUES (?, ?, ?, ?, ?, ?)`, 
        [name, map, 16, is_vip ? 1 : 0, owner, Date.now()], 
        () => res.json({ success: true })
    );
});

// Пинг от игры (чтобы сервер считался онлайн)
app.post('/api/servers/ping', (req, res) => {
    const { name } = req.body;
    db.run(`UPDATE servers SET last_ping = ? WHERE name = ?`, [Date.now(), name], () => res.json({ success: true }));
});

app.listen(PORT, () => console.log(`СЕРВЕР ЗАПУЩЕН: http://localhost:${PORT}`));
