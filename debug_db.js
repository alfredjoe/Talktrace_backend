const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'talktrace.db');
console.log(`Checking database at: ${dbPath}`);
const db = new sqlite3.Database(dbPath);

const REQUIRED_COLUMNS = [
    { name: 'bot_id', type: 'TEXT' },
    { name: 'process_state', type: "TEXT DEFAULT 'initializing'" },
    { name: 'current_timestamp', type: "INTEGER DEFAULT 0" },
    { name: 'file_paths', type: 'TEXT' }
];

db.serialize(() => {
    db.all("PRAGMA table_info(meetings)", (err, rows) => {
        if (err) {
            console.error("Error getting table info:", err);
            return;
        }

        const existingNames = rows.map(r => r.name);
        console.log("Existing columns:", existingNames.join(", "));

        REQUIRED_COLUMNS.forEach(col => {
            if (!existingNames.includes(col.name)) {
                console.log(`Missing column '${col.name}'. Adding...`);
                db.run(`ALTER TABLE meetings ADD COLUMN ${col.name} ${col.type}`, (err) => {
                    if (err) console.error(`FAILED to add ${col.name}:`, err.message);
                    else console.log(`SUCCESS: Added ${col.name}`);
                });
            } else {
                console.log(`Column '${col.name}' already exists.`);
            }
        });
    });
});
