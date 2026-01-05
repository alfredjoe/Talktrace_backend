const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'talktrace.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to SQLite database.');
        db.run(`CREATE TABLE IF NOT EXISTS meetings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            meeting_id TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    }
});

function addMeeting(userId, meetingId) {
    return new Promise((resolve, reject) => {
        const sql = 'INSERT INTO meetings (user_id, meeting_id) VALUES (?, ?)';
        db.run(sql, [userId, meetingId], function (err) {
            if (err) return reject(err);
            resolve(this.lastID);
        });
    });
}

function getMeeting(meetingId) {
    return new Promise((resolve, reject) => {
        const sql = 'SELECT * FROM meetings WHERE meeting_id = ?';
        db.get(sql, [meetingId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}



function updateMeetingId(oldId, newId) {
    return new Promise((resolve, reject) => {
        const sql = 'UPDATE meetings SET meeting_id = ? WHERE meeting_id = ?';
        db.run(sql, [newId, oldId], function (err) {
            if (err) return reject(err);
            resolve(this.changes);
        });
    });
}

module.exports = {
    db,
    addMeeting,
    getMeeting,
    updateMeetingId
};
