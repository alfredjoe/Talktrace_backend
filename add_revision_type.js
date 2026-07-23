const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'talktrace.db');
const db = new sqlite3.Database(dbPath);

console.log('Running migration: Add "type" to transcript_revisions...');

db.serialize(() => {
    db.run("ALTER TABLE transcript_revisions ADD COLUMN type TEXT DEFAULT 'transcript'", function (err) {
        if (err) {
            if (err.message.includes("duplicate column")) {
                console.log("Column 'type' already exists. Skipping.");
            } else {
                console.error("Migration Error:", err.message);
            }
        } else {
            console.log("Success: Added 'type' column to transcript_revisions.");
        }
    });
});
