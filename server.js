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

// Настройка загрузки файлов (аватарки)
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Создаем папку uploads, если её нет
        const dir = './uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname)); // Уникальное имя файла
    }
});
const upload = multer({ storage: storage });

app.use(express.json());
app.use(express.static(__dirname)); // Отдаем файлы сайта
app.use('/uploads', express.static('uploads')); // Отдаем загруженные аватарки

// ===== БАЗА ДАННЫХ =====
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error(err.message);
    console.log('Подключено к базе данных SQLite.');
});

db.serialize(() => {
    // Таблица пользователей
    db.run(`CREATE TABLE IF NOT EXISTS users (
        google_id TEXT UNIQUE,
        email TEXT,
        name TEXT,
        picture TEXT
    )`);
    // Таблица аддонов
    db.run(`CREATE TABLE IF NOT EXISTS addons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        author_name TEXT,
        title TEXT,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // Гостевая книга
    db.run(`CREATE TABLE IF NOT EXISTS guestbook (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_name TEXT,
        user_picture TEXT,
        message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// ===== API =====

// Вход
app.post('/api/login', async (req, res) => {
    const { token } = req.body;
    try {
        const ticket = await client.verifyIdToken({ idToken: token, audience: CLIENT_ID });
        const payload = ticket.getPayload();
        
        // Проверяем, есть ли уже такой юзер. Если есть — берем его кастомное имя и аватарку
        db.get(`SELECT * FROM users WHERE google_id = ?`, [payload.sub], (err, row) => {
            if (row) {
                res.json({ success: true, user: { name: row.name, picture: row.picture, google_id: row.google_id } });
            } else {
                // Если нет — создаем нового
                db.run(`INSERT INTO users (google_id, name, email, picture) VALUES (?, ?, ?, ?)`, 
                    [payload.sub, payload.given_name, payload.email, payload.picture], (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, user: { name: payload.given_name, picture: payload.picture, google_id: payload.sub } });
                });
            }
        });
    } catch (error) {
        res.status(401).json({ error: 'Недействительный токен' });
    }
});

// Обновление профиля (Имя и Аватарка)
app.post('/api/update-profile', upload.single('avatar'), (req, res) => {
    const { google_id, new_name } = req.body;
    let new_picture = req.file ? `/uploads/${req.file.filename}` : null;

    if (!google_id) return res.status(400).json({ error: 'Нет ID пользователя' });

    if (new_picture) {
        db.run(`UPDATE users SET name = ?, picture = ? WHERE google_id = ?`, [new_name, new_picture, google_id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, name: new_name, picture: new_picture });
        });
    } else {
        db.run(`UPDATE users SET name = ? WHERE google_id = ?`, [new_name, google_id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, name: new_name, picture: null }); // null значит аватарку не меняли
        });
    }
});

// Получить все аддоны
app.get('/api/addons', (req, res) => {
    db.all(`SELECT * FROM addons ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Создать аддон
app.post('/api/addons', (req, res) => {
    const { author_name, title, description } = req.body;
    if (!title || !description) return res.status(400).json({ error: 'Заполните поля' });
    
    db.run(`INSERT INTO addons (author_name, title, description) VALUES (?, ?, ?)`, 
        [author_name, title, description], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
});

// ==== ГОСТЕВАЯ КНИГА ====
app.get('/api/guestbook', (req, res) => {
    db.all(`SELECT * FROM guestbook ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/guestbook', (req, res) => {
    const { name, picture, message } = req.body;
    if (!message) return res.status(400).json({ error: 'Сообщение пустое' });
    db.run(`INSERT INTO guestbook (user_name, user_picture, message) VALUES (?, ?, ?)`, [name, picture, message], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
});