const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { OAuth2Client } = require('google-auth-library');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ВСТАВЬ СЮДА СВОЙ CLIENT ID ИЗ GOOGLE CLOUD
const CLIENT_ID = '457542589559-ngi47p1c12cbl2eid6u1epcdi2trcf7g.apps.googleusercontent.com';
const client = new OAuth2Client(CLIENT_ID);

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static('uploads'));

// ===== БАЗА ДАННЫХ =====
const db = new sqlite3.Database('./database.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (google_id TEXT UNIQUE, name TEXT, picture TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS guestbook (id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS addons (id INTEGER PRIMARY KEY AUTOINCREMENT, author_name TEXT, title TEXT, description TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, map TEXT, max_players INTEGER, current_players INTEGER)`);
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

app.get('/api/guestbook', (req, res) => db.all(`SELECT * FROM guestbook ORDER BY id DESC`, [], (e, r) => res.json(r)));
app.post('/api/guestbook', (req, res) => db.run(`INSERT INTO guestbook (user_name, message) VALUES (?, ?)`, [req.body.name, req.body.message], () => res.json({ success: true })));

app.get('/api/addons', (req, res) => db.all(`SELECT * FROM addons ORDER BY id DESC`, [], (e, r) => res.json(r)));
app.post('/api/addons', (req, res) => db.run(`INSERT INTO addons (author_name, title, description) VALUES (?, ?, ?)`, [req.body.author, req.body.title, req.body.desc], () => res.json({ success: true })));

app.get('/api/servers', (req, res) => db.all(`SELECT * FROM servers`, [], (e, r) => res.json(r)));
app.post('/api/servers', (req, res) => db.run(`INSERT INTO servers (name, map, max_players, current_players) VALUES (?, ?, ?, ?)`, [req.body.name, req.body.map, 16, Math.floor(Math.random() * 10)], () => res.json({ success: true })));

app.listen(PORT, () => console.log(`СЕРВЕР ЗАПУЩЕН: http://localhost:${PORT}`));
