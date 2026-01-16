const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'talktrace.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // 1. Rename existing table
    db.run("ALTER TABLE meetings RENAME TO meetings_legacy_v1", (err) => {
        if (err) {
            console.error("Error renaming table (maybe already renamed?):", err.message);
            // Verify if meetings exists, if not, proceed to create
        } else {
            console.log("Renamed 'meetings' to 'meetings_legacy_v1'.");
        }

        // 2. Create NEW table with correct schema
        db.run(`CREATE TABLE meetings (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            bot_id TEXT,
            status TEXT DEFAULT 'processing',
            created_at INTEGER,
            process_state TEXT DEFAULT 'initializing',
            current_timestamp INTEGER DEFAULT 0,
            file_paths TEXT
        )`, (err) => {
            if (err) {
                console.error("Error creating new table:", err.message);
                return;
            }
            console.log("Created new 'meetings' table.");

            // 3. Migrate Data
            // Assumes 'meeting_id' in old table corresponds to the new 'id' (Bot UUID)
            const migrateSql = `
                INSERT INTO meetings (id, user_id, bot_id, created_at, process_state, current_timestamp, file_paths)
                SELECT 
                    COALESCE(meeting_id, CAST(id AS TEXT)), -- Try to use meeting_id as PK, else fallback to old ID string
                    user_id,
                    COALESCE(bot_id, meeting_id), -- Try to fill bot_id
                    created_at,
                    COALESCE(process_state, 'initializing'),
                    COALESCE(current_timestamp, 0),
                    file_paths
                FROM meetings_legacy_v1
                WHERE meeting_id IS NOT NULL OR bot_id IS NOT NULL; -- Only migrate meaningful rows
            `;

            db.run(migrateSql, function (err) {
                if (err) console.error("Data migration warning:", err.message);
                else console.log(`Migrated ${this.changes} rows from legacy table.`);
            });
        });
    });
});
