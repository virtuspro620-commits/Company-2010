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
        if (file.fieldname === 'plugin_file') dir = './server_plugins'; // Для плагинов сервера
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
app.use('/server_plugins', express.static('server_plugins'));

// ===== БАЗА ДАННЫХ =====
const db = new sqlite3.Database('./database.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (google_id TEXT UNIQUE, name TEXT, picture TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS guestbook (id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS addons (id INTEGER PRIMARY KEY AUTOINCREMENT, author_name TEXT, title TEXT, description TEXT, cover_url TEXT, py_file_url TEXT, downloads INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        name TEXT, 
        map TEXT, 
        tariff TEXT,
        max_players INTEGER, 
        is_vip INTEGER DEFAULT 0, 
        owner TEXT, 
        last_ping INTEGER DEFAULT 0,
        console_logs TEXT DEFAULT ''
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
        () => res.json({ success: true })
    );
});
app.post('/api/addons/:id/download', (req, res) => db.run(`UPDATE addons SET downloads = downloads + 1 WHERE id = ?`, [req.params.id], () => res.json({ success: true })));

// Сервера
app.get('/api/servers', (req, res) => {
    const now = Date.now();
    db.all(`SELECT * FROM servers`, [], (e, rows) => {
        if (e) return res.json([]);
        const result = rows.map(s => {
            const isOnline = (now - s.last_ping) < 15000; 
            return {
                ...s,
                current_players: isOnline ? 1 : 0,
                status: isOnline ? 'ONLINE' : 'OFFLINE'
            };
        });
        res.json(result);
    });
});

app.post('/api/servers', (req, res) => {
    const { name, map, tariff, owner } = req.body;
    let max_pl = 10;
    if (tariff === '1gb') max_pl = 20;
    if (tariff === '3gb') max_pl = 50;
    
    db.run(`INSERT INTO servers (name, map, tariff, max_players, owner, last_ping, console_logs) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
        [name, map, tariff, max_pl, owner, Date.now(), '[SYSTEM] Server initialized.\n[SYSTEM] Waiting for connection...\n'], 
        () => res.json({ success: true })
    );
});

app.post('/api/servers/ping', (req, res) => {
    db.run(`UPDATE servers SET last_ping = ? WHERE name = ?`, [Date.now(), req.body.name], () => res.json({ success: true }));
});

// КОНСОЛЬ СЕРВЕРА
app.post('/api/servers/console', (req, res) => {
    const { server_name, command } = req.body;
    db.get(`SELECT console_logs FROM servers WHERE name = ?`, [server_name], (err, row) => {
        if (!row) return res.status(404).json({ error: 'Server not found' });
        
        let new_logs = row.console_logs + `> ${command}\n`;
        
        // Симуляция команд
        if (command === 'help') new_logs += `[HELP] Available commands: status, say <msg>, kick <player>, plugins, reload, stop\n`;
        else if (command === 'status') new_logs += `[STATUS] Server is running. Memory: OK. Players: 1/${row.max_players || 16}\n`;
        else if (command.startsWith('say ')) new_logs += `[CHAT] ${command.substring(4)}\n`;
        else if (command === 'plugins') new_logs += `[PLUGINS] Loaded: Core, Anti-Cheat, VIP-Chat\n`;
        else if (command === 'reload') new_logs += `[SYSTEM] Reloading configs... Done.\n`;
        else if (command === 'stop') new_logs += `[SYSTEM] Stopping server... (Close page to kill process)\n`;
        else new_logs += `[ERROR] Unknown command: ${command}\n`;

        db.run(`UPDATE servers SET console_logs = ? WHERE name = ?`, [new_logs, server_name], () => {
            res.json({ success: true, logs: new_logs });
        });
    });
});

app.listen(PORT, () => console.log(`СЕРВЕР ЗАПУЩЕН: http://localhost:${PORT}`));
