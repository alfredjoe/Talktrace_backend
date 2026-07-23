const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'talktrace.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.all("PRAGMA table_info(meetings)", (err, rows) => {
        if (err) {
            console.error(err);
            return;
        }
        console.log("Detailed Schema:");
        console.table(rows);
        rows.forEach(r => console.log(`${r.name}: ${r.type} (pk: ${r.pk})`));
    });
});
