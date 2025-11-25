const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/app/data/shopping.db';

// Zorg dat de data map bestaat
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)){
    fs.mkdirSync(dataDir, { recursive: true });
}

// Middleware
app.use(bodyParser.json());
app.use(express.static('public')); // Serveer de HTML uit de public map

// Database Setup
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('Error opening database:', err.message);
    else console.log('Connected to SQLite database at', DB_PATH);
});

// Maak tabellen aan als ze niet bestaan
db.serialize(() => {
    // We slaan de lijst op als JSON string in de kolom 'data'
    db.run(`CREATE TABLE IF NOT EXISTS lists (
        id TEXT PRIMARY KEY,
        name TEXT,
        data TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        itemCount INTEGER
    )`);
});

// --- API ENDPOINTS ---

// 1. Haal alle opgeslagen lijsten op
app.get('/api/lists', (req, res) => {
    db.all("SELECT data FROM lists", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // Parse de JSON strings terug naar objecten
        const lists = rows.map(row => JSON.parse(row.data));
        res.json(lists);
    });
});

// 2. Sla een lijst op (of update)
app.post('/api/lists', (req, res) => {
    const list = req.body;
    if (!list.id || !list.name) return res.status(400).json({ error: "Invalid list data" });

    const stmt = db.prepare("INSERT INTO lists (id, name, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, data=excluded.data");
    stmt.run(list.id, list.name, JSON.stringify(list), function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: "success", id: list.id });
    });
    stmt.finalize();
});

// 3. Verwijder een lijst
app.delete('/api/lists/:id', (req, res) => {
    const id = req.params.id;
    db.run("DELETE FROM lists WHERE id = ?", id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: "deleted", changes: this.changes });
    });
});

// 4. Haal geschiedenis op
app.get('/api/history', (req, res) => {
    db.all("SELECT * FROM history ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 5. Voeg geschiedenis toe
app.post('/api/history', (req, res) => {
    const { date, itemCount } = req.body;
    db.run("INSERT INTO history (date, itemCount) VALUES (?, ?)", [date, itemCount], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: "success", id: this.lastID });
    });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
