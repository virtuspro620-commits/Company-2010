const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { OAuth2Client } = require('google-auth-library');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ВСТАВЬ СЮДА СВОЙ CLIENT ID
const CLIENT_ID = '457542589559-ngi47p1c12cbl2eid6u1epcdi2trcf7g.apps.googleusercontent.com';
const client = new OAuth2Client(CLIENT_ID);

// Настройка Multer для загрузки файлов (картинки и .py скрипты)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let dir = './uploads';
        if (file.fieldname === 'py_file') dir = './addons_files'; // Папка для скриптов
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage: storage });

app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static('uploads'));
app.use('/addons_files', express.static('addons_files')); // Доступ к файлам модов

// ===== БАЗА ДАННЫХ =====
const db = new sqlite3.Database('./database.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (google_id TEXT UNIQUE, name TEXT, picture TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS guestbook (id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    
    // Обновленная таблица аддонов (добавили файлы)
    db.run(`CREATE TABLE IF NOT EXISTS addons (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        author_name TEXT, 
        title TEXT, 
        description TEXT, 
        cover_url TEXT, 
        py_file_url TEXT, 
        downloads INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Обновленная таблица серверов (добавили VIP)
    db.run(`CREATE TABLE IF NOT EXISTS servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        name TEXT, 
        map TEXT, 
        max_players INTEGER, 
        current_players INTEGER,
        is_vip INTEGER DEFAULT 0
    )`);
});

// ===== API =====
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

app.post('/api/update-profile', upload.single('avatar'), (req, res) => {
    const { google_id, new_name } = req.body;
    const new_pic = req.file ? `/uploads/${req.file.filename}` : null;
    if (new_pic) db.run(`UPDATE users SET name = ?, picture = ? WHERE google_id = ?`, [new_name, new_pic, google_id], () => res.json({ success: true, name: new_name, picture: new_pic }));
    else db.run(`UPDATE users SET name = ? WHERE google_id = ?`, [new_name, google_id], () => res.json({ success: true, name: new_name, picture: null }));
});

// --- АДДОНЫ ---
app.get('/api/addons', (req, res) => db.all(`SELECT * FROM addons ORDER BY id DESC`, [], (e, r) => res.json(r)));

// Загрузка аддона (2 файла: обложка и .py скрипт)
app.post('/api/addons/upload', upload.fields([{ name: 'cover', maxCount: 1 }, { name: 'py_file', maxCount: 1 }]), (req, res) => {
    const { author, title, desc } = req.body;
    const cover_url = req.files['cover'] ? `/uploads/${req.files['cover'][0].filename}` : null;
    const py_file_url = req.files['py_file'] ? `/addons_files/${req.files['py_file'][0].filename}` : null;

    db.run(`INSERT INTO addons (author_name, title, description, cover_url, py_file_url) VALUES (?, ?, ?, ?, ?)`, 
        [author, title, desc, cover_url, py_file_url], 
        (err) => { if (err) return res.status(500).json({error: err.message}); res.json({ success: true }); }
    );
});

// Увеличение счетчика скачиваний
app.post('/api/addons/:id/download', (req, res) => {
    db.run(`UPDATE addons SET downloads = downloads + 1 WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

// --- СЕРВЕРА ---
app.get('/api/servers', (req, res) => db.all(`SELECT * FROM servers ORDER BY is_vip DESC, id DESC`, [], (e, r) => res.json(r)));

app.post('/api/servers', (req, res) => {
    const { name, map, is_vip } = req.body;
    db.run(`INSERT INTO servers (name, map, max_players, current_players, is_vip) VALUES (?, ?, ?, ?, ?)`, 
        [name, map, 16, Math.floor(Math.random() * 10), is_vip ? 1 : 0], 
        () => res.json({ success: true })
    );
});

// --- ГОСТЕВАЯ ---
app.get('/api/guestbook', (req, res) => db.all(`SELECT * FROM guestbook ORDER BY id DESC`, [], (e, r) => res.json(r)));
app.post('/api/guestbook', (req, res) => db.run(`INSERT INTO guestbook (user_name, message) VALUES (?, ?)`, [req.body.name, req.body.message], () => res.json({ success: true })));

app.listen(PORT, () => console.log(`СЕРВЕР ЗАПУЩЕН: http://localhost:${PORT}`));
