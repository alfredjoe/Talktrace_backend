const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'talktrace.db');
const db = new sqlite3.Database(dbPath);

console.log("Running migration: Add active_version to meetings...");

db.serialize(() => {
    db.run("ALTER TABLE meetings ADD COLUMN active_version INTEGER DEFAULT 0", (err) => {
        if (err) {
            if (err.message.includes("duplicate column")) {
                console.log("Column 'active_version' already exists.");
            } else {
                console.error("Migration failed:", err.message);
            }
        } else {
            console.log("Migration successful: Added 'active_version' column.");
        }
    });
});

db.close(() => console.log("Database connection closed."));
