const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'talktrace.db');
console.log(`Checking database at: ${dbPath}`);
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // 1. Check if 'meetings' table exists
    db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='meetings'", (err, row) => {
        if (err) {
            console.error("Error checking table existence:", err);
            return;
        }
        if (!row) {
            console.log("Table 'meetings' does not exist! It should be created by server startup.");
            return;
        }
        console.log("Table 'meetings' found.");

        // 2. Check columns in 'meetings'
        db.all("PRAGMA table_info(meetings)", (err, rows) => {
            if (err) {
                console.error("Error getting table info:", err);
                return;
            }

            console.log("Existing columns:", rows.map(r => r.name).join(", "));

            const hasBotId = rows.some(r => r.name === 'bot_id');
            if (hasBotId) {
                console.log("Column 'bot_id' ALREADY EXISTS.");
            } else {
                console.log("Column 'bot_id' MISSING. Attempting to add...");
                db.run("ALTER TABLE meetings ADD COLUMN bot_id TEXT", (err) => {
                    if (err) {
                        console.error("FAILED to add column:", err.message);
                    } else {
                        console.log("SUCCESS: Added 'bot_id' column.");
                    }
                });
            }
        });
    });
});
