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

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let dir = './uploads';
        if (file.fieldname === 'py_file') dir = './addons_files';
        if (file.fieldname === 'gallery_image') dir = './gallery'; // Для галереи
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
app.use('/gallery', express.static('gallery'));

// ===== БАЗА ДАННЫХ =====
const db = new sqlite3.Database('./database.db');

db.serialize(() => {
    // Пользователи (добавили bio, email, vk, discord)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        google_id TEXT UNIQUE, name TEXT, picture TEXT, 
        bio TEXT, email TEXT, vk TEXT, discord TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS guestbook (id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    
    // Аддоны
    db.run(`CREATE TABLE IF NOT EXISTS addons (id INTEGER PRIMARY KEY AUTOINCREMENT, author_name TEXT, title TEXT, description TEXT, cover_url TEXT, py_file_url TEXT, downloads INTEGER DEFAULT 0)`);
    
    // Комментарии к аддонам
    db.run(`CREATE TABLE IF NOT EXISTS addon_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, addon_id INTEGER, author_name TEXT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

    // Сервера
    db.run(`CREATE TABLE IF NOT EXISTS servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, map TEXT, tariff TEXT, max_players INTEGER, is_vip INTEGER DEFAULT 0, owner TEXT, last_ping INTEGER DEFAULT 0, console_logs TEXT DEFAULT '')`);

    // Галерея
    db.run(`CREATE TABLE IF NOT EXISTS gallery (id INTEGER PRIMARY KEY AUTOINCREMENT, author_name TEXT, image_url TEXT, likes INTEGER DEFAULT 0)`);

    // Посты (Новости)
    db.run(`CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, author_name TEXT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});

// ===== API =====
app.post('/api/login', async (req, res) => {
    try {
        const ticket = await client.verifyIdToken({ idToken: req.body.token, audience: CLIENT_ID });
        const payload = ticket.getPayload();
        db.get(`SELECT * FROM users WHERE google_id = ?`, [payload.sub], (err, row) => {
            if (row) res.json({ success: true, user: row });
            else {
                db.run(`INSERT INTO users (google_id, name, picture, bio, email, vk, discord) VALUES (?, ?, ?, '', '', '', '')`, 
                [payload.sub, payload.given_name, payload.picture], () => {
                    db.get(`SELECT * FROM users WHERE google_id = ?`, [payload.sub], (e, r) => res.json({ success: true, user: r }));
                });
            }
        });
    } catch (e) { res.status(401).json({ error: 'Auth failed' }); }
});

app.post('/api/update-profile', upload.single('avatar'), (req, res) => {
    const { google_id, new_name, bio, email, vk, discord } = req.body;
    const new_pic = req.file ? `/uploads/${req.file.filename}` : null;
    
    let sql = `UPDATE users SET name = ?, bio = ?, email = ?, vk = ?, discord = ? WHERE google_id = ?`;
    let params = [new_name, bio, email, vk, discord, google_id];

    if (new_pic) {
        sql = `UPDATE users SET name = ?, bio = ?, email = ?, vk = ?, discord = ?, picture = ? WHERE google_id = ?`;
        params = [new_name, bio, email, vk, discord, new_pic, google_id];
    }
    
    db.run(sql, params, () => {
        db.get(`SELECT * FROM users WHERE google_id = ?`, [google_id], (e, r) => res.json({ success: true, user: r }));
    });
});

// Аддоны и Комментарии
app.get('/api/addons', (req, res) => db.all(`SELECT * FROM addons ORDER BY id DESC`, [], (e, r) => res.json(r)));
app.post('/api/addons/upload', upload.fields([{ name: 'cover', maxCount: 1 }, { name: 'py_file', maxCount: 1 }]), (req, res) => {
    const { author, title, desc } = req.body;
    const cover_url = req.files['cover'] ? `/uploads/${req.files['cover'][0].filename}` : '/resources/images/banner-bg.jpg';
    const py_file_url = req.files['py_file'] ? `/addons_files/${req.files['py_file'][0].filename}` : null;
    db.run(`INSERT INTO addons (author_name, title, description, cover_url, py_file_url) VALUES (?, ?, ?, ?, ?)`, 
        [author, title, desc, cover_url, py_file_url], () => res.json({ success: true }));
});
app.post('/api/addons/:id/download', (req, res) => db.run(`UPDATE addons SET downloads = downloads + 1 WHERE id = ?`, [req.params.id], () => res.json({ success: true })));

app.get('/api/addons/:id/comments', (req, res) => db.all(`SELECT * FROM addon_comments WHERE addon_id = ? ORDER BY id DESC`, [req.params.id], (e, r) => res.json(r)));
app.post('/api/addons/:id/comments', (req, res) => db.run(`INSERT INTO addon_comments (addon_id, author_name, message) VALUES (?, ?, ?)`, 
    [req.params.id, req.body.author, req.body.message], () => res.json({ success: true })));

// Галерея
app.get('/api/gallery', (req, res) => db.all(`SELECT * FROM gallery ORDER BY id DESC`, [], (e, r) => res.json(r)));
app.post('/api/gallery/upload', upload.single('gallery_image'), (req, res) => {
    if (!req.file) return res.status(400).json({error: "No file"});
    db.run(`INSERT INTO gallery (author_name, image_url) VALUES (?, ?)`, [req.body.author, `/gallery/${req.file.filename}`], () => res.json({ success: true }));
});
app.post('/api/gallery/:id/like', (req, res) => db.run(`UPDATE gallery SET likes = likes + 1 WHERE id = ?`, [req.params.id], () => res.json({ success: true })));

// Посты
app.get('/api/posts', (req, res) => db.all(`SELECT * FROM posts ORDER BY id DESC`, [], (e, r) => res.json(r)));
app.post('/api/posts', (req, res) => db.run(`INSERT INTO posts (author_name, message) VALUES (?, ?)`, [req.body.author, req.body.message], () => res.json({ success: true })));

// Сервера
app.get('/api/servers', (req, res) => {
    const now = Date.now();
    db.all(`SELECT * FROM servers`, [], (e, rows) => {
        if (e) return res.json([]);
        const result = rows.map(s => {
            const isOnline = (now - s.last_ping) < 15000; 
            return { ...s, current_players: isOnline ? 1 : 0, status: isOnline ? 'ONLINE' : 'OFFLINE' };
        });
        res.json(result);
    });
});
app.post('/api/servers', (req, res) => {
    const { name, map, tariff, owner } = req.body;
    let max_pl = tariff === '3gb' ? 50 : tariff === '1gb' ? 20 : 10;
    db.run(`INSERT INTO servers (name, map, tariff, max_players, owner, last_ping, console_logs) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
        [name, map, tariff, max_pl, owner, Date.now(), '[SYSTEM] Server initialized.\n'], () => res.json({ success: true }));
});
app.post('/api/servers/ping', (req, res) => db.run(`UPDATE servers SET last_ping = ? WHERE name = ?`, [Date.now(), req.body.name], () => res.json({ success: true })));
app.post('/api/servers/console', (req, res) => {
    const { server_name, command } = req.body;
    db.get(`SELECT console_logs FROM servers WHERE name = ?`, [server_name], (err, row) => {
        if (!row) return res.status(404).json({ error: 'Server not found' });
        let new_logs = row.console_logs + `> ${command}\n`;
        if (command === 'help') new_logs += `[HELP] Available: status, say <msg>, plugins, reload\n`;
        else if (command === 'status') new_logs += `[STATUS] Online. Players: 1\n`;
        else if (command.startsWith('say ')) new_logs += `[CHAT] ${command.substring(4)}\n`;
        else if (command === 'plugins') new_logs += `[PLUGINS] Core, Anti-Cheat, VIP-Chat\n`;
        else if (command === 'reload') new_logs += `[SYSTEM] Reloading... Done.\n`;
        else new_logs += `[ERROR] Unknown command\n`;
        db.run(`UPDATE servers SET console_logs = ? WHERE name = ?`, [new_logs, server_name], () => res.json({ success: true, logs: new_logs }));
    });
});

app.get('/api/guestbook', (req, res) => db.all(`SELECT * FROM guestbook ORDER BY id DESC`, [], (e, r) => res.json(r)));
app.post('/api/guestbook', (req, res) => db.run(`INSERT INTO guestbook (user_name, message) VALUES (?, ?)`, [req.body.name, req.body.message], () => res.json({ success: true })));

app.listen(PORT, () => console.log(`СЕРВЕР ЗАПУЩЕН: http://localhost:${PORT}`));
