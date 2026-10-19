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
        if (file.fieldname === 'gallery_image') dir = './gallery';
        if (file.fieldname === 'skin_file') dir = './skins'; // Папка для скинов
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
app.use('/skins', express.static('skins'));

const db = new sqlite3.Database('./database.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (google_id TEXT UNIQUE, name TEXT, picture TEXT, bio TEXT, email TEXT, vk TEXT, discord TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS guestbook (id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS addons (id INTEGER PRIMARY KEY AUTOINCREMENT, author_name TEXT, title TEXT, description TEXT, cover_url TEXT, py_file_url TEXT, downloads INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS addon_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, addon_id INTEGER, author_name TEXT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, map TEXT, tariff TEXT, max_players INTEGER, is_vip INTEGER DEFAULT 0, owner TEXT, last_ping INTEGER DEFAULT 0, console_logs TEXT DEFAULT '')`);
    db.run(`CREATE TABLE IF NOT EXISTS gallery (id INTEGER PRIMARY KEY AUTOINCREMENT, author_name TEXT, image_url TEXT, likes INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, author_name TEXT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    // НОВАЯ ТАБЛИЦА: СКИНЫ
    db.run(`CREATE TABLE IF NOT EXISTS skins (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        author_name TEXT, 
        title TEXT, 
        description TEXT, 
        image_url TEXT, 
        skin_file_url TEXT,
        downloads INTEGER DEFAULT 0
    )`);
});

// API (Авторизация и Профиль - без изменений)
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

// Моды, Галерея, Посты, Сервера (код из прошлого шага оставляем как есть)
// ... (вставь сюда код для аддонов, галереи, постов, серверов, который был выше) ...

// НОВЫЙ БЛОК: СКИНЫ
app.get('/api/skins', (req, res) => db.all(`SELECT * FROM skins ORDER BY id DESC`, [], (e, r) => res.json(r)));

app.post('/api/skins/upload', upload.fields([{ name: 'skin_image', maxCount: 1 }, { name: 'skin_file', maxCount: 1 }]), (req, res) => {
    const { author, title, desc } = req.body;
    const image_url = req.files['skin_image'] ? `/skins/${req.files['skin_image'][0].filename}` : null;
    const skin_file_url = req.files['skin_file'] ? `/skins/${req.files['skin_file'][0].filename}` : null;

    db.run(`INSERT INTO skins (author_name, title, description, image_url, skin_file_url) VALUES (?, ?, ?, ?, ?)`, 
        [author, title, desc, image_url, skin_file_url], 
        () => res.json({ success: true })
    );
});

app.post('/api/skins/:id/download', (req, res) => {
    db.run(`UPDATE skins SET downloads = downloads + 1 WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

app.listen(PORT, () => console.log(`СЕРВЕР ЗАПУЩЕН: http://localhost:${PORT}`));
