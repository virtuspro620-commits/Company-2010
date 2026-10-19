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

// Хранилище для файлов
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let dir = './uploads';
        if (file.fieldname === 'py_file') dir = './addons_files';
        if (file.fieldname === 'gallery_image') dir = './gallery';
        if (file.fieldname === 'skin_image' || file.fieldname === 'skin_file') dir = './skins';
        
        // АВТОМАТИЧЕСКОЕ СОЗДАНИЕ ПАПОК
        if (!fs.existsSync(dir)) { 
            fs.mkdirSync(dir, { recursive: true }); 
            console.log(`[SYSTEM] Создана папка: ${dir}`);
        }
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

// База данных
const db = new sqlite3.Database('./database.db');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (google_id TEXT UNIQUE, name TEXT, picture TEXT, bio TEXT, email TEXT, vk TEXT, discord TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS guestbook (id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS addons (id INTEGER PRIMARY KEY AUTOINCREMENT, author_name TEXT, title TEXT, description TEXT, cover_url TEXT, py_file_url TEXT, downloads INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS addon_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, addon_id INTEGER, author_name TEXT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, map TEXT, tariff TEXT, max_players INTEGER, is_vip INTEGER DEFAULT 0, owner TEXT, last_ping INTEGER DEFAULT 0, console_logs TEXT DEFAULT '')`);
    db.run(`CREATE TABLE IF NOT EXISTS gallery (id INTEGER PRIMARY KEY AUTOINCREMENT, author_name TEXT, image_url TEXT, likes INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, author_name TEXT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS skins (id INTEGER PRIMARY KEY AUTOINCREMENT, author_name TEXT, title TEXT, description TEXT, image_url TEXT, skin_file_url TEXT, downloads INTEGER DEFAULT 0)`);
});

// === API (Профиль, Посты, Гостевая, Сервера, Галерея) ===
// (Оставляем код из прошлых сообщений, я не буду его дублировать, чтобы не раздувать ответ)
// ... ВСТАВЬ СЮДА ВСЕ МАРШРУТЫ ИЗ ПРОШЛОГО SERVER.JS ...

// --- ИСПРАВЛЕННЫЕ МАРШРУТЫ ДЛЯ АДДОНОВ И СКИНОВ ---

app.get('/api/addons', (req, res) => db.all(`SELECT * FROM addons ORDER BY id DESC`, [], (e, r) => res.json(r)));
app.post('/api/addons/upload', upload.fields([{ name: 'cover', maxCount: 1 }, { name: 'py_file', maxCount: 1 }]), (req, res) => {
    try {
        const { author, title, desc } = req.body;
        const cover_url = req.files['cover'] ? `/uploads/${req.files['cover'][0].filename}` : '/resources/images/banner-bg.jpg';
        const py_file_url = req.files['py_file'] ? `/addons_files/${req.files['py_file'][0].filename}` : null;

        if (!py_file_url) return res.status(400).json({ error: 'Файл .py не загружен' });

        db.run(`INSERT INTO addons (author_name, title, description, cover_url, py_file_url) VALUES (?, ?, ?, ?, ?)`, 
            [author, title, desc, cover_url, py_file_url], 
            (err) => { 
                if (err) { console.error(err); return res.status(500).json({ error: 'Ошибка БД' }); }
                res.json({ success: true }); 
            }
        );
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Ошибка сервера при загрузке аддона' });
    }
});

app.get('/api/skins', (req, res) => db.all(`SELECT * FROM skins ORDER BY id DESC`, [], (e, r) => res.json(r)));
app.post('/api/skins/upload', upload.fields([{ name: 'skin_image', maxCount: 1 }, { name: 'skin_file', maxCount: 1 }]), (req, res) => {
    try {
        const { author, title, desc } = req.body;
        const image_url = req.files['skin_image'] ? `/skins/${req.files['skin_image'][0].filename}` : '/resources/images/banner-bg.jpg';
        const skin_file_url = req.files['skin_file'] ? `/skins/${req.files['skin_file'][0].filename}` : null;

        if (!skin_file_url) return res.status(400).json({ error: 'Файл скина не загружен' });

        db.run(`INSERT INTO skins (author_name, title, description, image_url, skin_file_url) VALUES (?, ?, ?, ?, ?)`, 
            [author, title, desc, image_url, skin_file_url], 
            (err) => { 
                if (err) { console.error(err); return res.status(500).json({ error: 'Ошибка БД' }); }
                res.json({ success: true }); 
            }
        );
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Ошибка сервера при загрузке скина' });
    }
});

// ... ОСТАЛЬНЫЕ МАРШРУТЫ (ping, console, comments и т.д.) ...

app.listen(PORT, () => console.log(`СЕРВЕР ЗАПУЩЕН: http://localhost:${PORT}`));
