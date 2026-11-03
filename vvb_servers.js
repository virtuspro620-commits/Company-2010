// API серверов Very Very Blood: отдельный модуль, без фальшивого онлайна

module.exports = function(app, db, requireUser) {
    
    // 1. Получить список серверов (с реальным онлайном)
    app.get('/api/servers', (req, res) => {
        const now = Date.now();
        db.all(`SELECT * FROM servers`, [], (e, rows) => {
            if (e) return res.json([]);
            const result = rows.map(s => {
                // Сервер онлайн, если пинг был менее 15 секунд назад
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

    // 2. Создать новый сервер
    app.post('/api/servers', requireUser, (req, res) => {
        const { name, map, tariff, plugins } = req.body;
        const owner = req.user.name;
        
        let max_pl = tariff === '3gb' ? 50 : tariff === '1gb' ? 20 : 10;
        const pluginsString = JSON.stringify(plugins || []);

        db.run(`INSERT INTO servers (name, map, tariff, max_players, owner, last_ping, console_logs, plugins) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
            [name, map, tariff, max_pl, owner, Date.now(), '[SYSTEM] Server initialized.\n', pluginsString], 
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, id: this.lastID });
            }
        );
    });

    // 3. Пинг от игры (чтобы сервер считался онлайн)
    app.post('/api/servers/ping', (req, res) => {
        const { name } = req.body;
        db.run(`UPDATE servers SET last_ping = ? WHERE name = ?`, [Date.now(), name], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });

    // 4. Получить конфиг плагинов для игры
    app.get('/api/servers/:name/config', (req, res) => {
        db.get(`SELECT plugins FROM servers WHERE name = ?`, [req.params.name], (err, row) => {
            if (!row) return res.status(404).json({ error: 'Server not found' });
            
            const pluginIds = JSON.parse(row.plugins || '[]');
            if (pluginIds.length === 0) return res.json([]);
            
            const placeholders = pluginIds.map(() => '?').join(',');
            db.all(`SELECT title, py_file_url FROM plugins WHERE id IN (${placeholders})`, pluginIds, (e, plugins) => {
                res.json(plugins);
            });
        });
    });

    // 5. Консоль сервера (выполнение команд)
    app.post('/api/servers/console', (req, res) => {
        const { server_name, command } = req.body;
        
        db.get(`SELECT console_logs FROM servers WHERE name = ?`, [server_name], (err, row) => {
            if (!row) return res.status(404).json({ error: 'Server not found' });
            
            let new_logs = row.console_logs + `> ${command}\n`;
            
            // Простая симуляция команд
            if (command === 'help') new_logs += `[HELP] Available: status, say <msg>, plugins, reload\n`;
            else if (command === 'status') new_logs += `[STATUS] Online. Players: 1\n`;
            else if (command.startsWith('say ')) new_logs += `[CHAT] ${command.substring(4)}\n`;
            else if (command === 'plugins') new_logs += `[PLUGINS] Core, Anti-Cheat, VIP-Chat\n`;
            else if (command === 'reload') new_logs += `[SYSTEM] Reloading... Done.\n`;
            else new_logs += `[ERROR] Unknown command\n`;

            db.run(`UPDATE servers SET console_logs = ? WHERE name = ?`, [new_logs, server_name], () => {
                res.json({ success: true, logs: new_logs });
            });
        });
    });

    console.log("[SERVER] Модуль серверов загружен.");
};
