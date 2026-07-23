const { db } = require('./database');

db.serialize(() => {
    // Check if column exists logic is hard in SQLite simply.
    // Just try adding it, catch error if exists (SQLITE_ERROR).
    db.run("ALTER TABLE meetings ADD COLUMN duration_seconds INTEGER DEFAULT 0", (err) => {
        if (err) {
            if (err.message.includes("duplicate column name")) {
                console.log("Column 'duration_seconds' already exists.");
            } else {
                console.error("Error adding column:", err);
            }
        } else {
            console.log("Column 'duration_seconds' added successfully.");
        }
    });
});
