const fs = require('fs');
const { db } = require('./database');

const targetId = "7a226981-1cd2-4e07-8cc0-08d2fb42a126";

db.get("SELECT * FROM meetings WHERE id = ?", [targetId], (err, row) => {
    if (err) {
        console.error("DB Error:", err);
    } else {
        if (!row) {
            console.log("Meeting NOT FOUND");
            fs.writeFileSync('meetings_dump.txt', "NOT FOUND");
        } else {
            console.log("Found Meeting:");
            console.log(JSON.stringify(row));
            fs.writeFileSync('meetings_dump.txt', JSON.stringify(row));
        }
    }
});
