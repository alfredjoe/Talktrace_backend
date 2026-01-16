const fs = require('fs');
const { db } = require('./database');

const targetId = "e3e8e62a-a1eb-478f-bc7a-3b838c7b539b";

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
