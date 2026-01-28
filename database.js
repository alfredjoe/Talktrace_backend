const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { protectKey, unprotectKey } = require('./crypto_utils');

const dbPath = path.resolve(__dirname, 'talktrace.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to SQLite database at:', dbPath);

        // DEBUG SCHEMA
        db.all("PRAGMA table_info(meetings)", (e, r) => {
            if (r) console.log("DEBUG: meetings schema:", r.map(c => c.name).join(', '));
        });

        initializeDatabase();
    }
});

function initializeDatabase() {
    db.serialize(() => {
        // 1. Meetings Table (Updated Schema)
        db.run(`CREATE TABLE IF NOT EXISTS meetings (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            bot_id TEXT,
            status TEXT DEFAULT 'processing',
            created_at INTEGER,
            process_state TEXT DEFAULT 'initializing',
            current_timestamp INTEGER DEFAULT 0,
            file_paths TEXT,
            duration_seconds INTEGER DEFAULT 0
        )`);

        // 2. Meeting Keys Table (Encrypted Vault)
        db.run(`CREATE TABLE IF NOT EXISTS meeting_keys (
            meeting_id TEXT PRIMARY KEY,
            encrypted_key_blob TEXT NOT NULL,
            iv TEXT NOT NULL,
            auth_tag TEXT NOT NULL,
            FOREIGN KEY(meeting_id) REFERENCES meetings(id)
        )`);

        // 3. Transcript Revisions (History & Integrity)
        db.run(`CREATE TABLE IF NOT EXISTS transcript_revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            content_hash TEXT NOT NULL,
            file_path TEXT NOT NULL,
            edited_at INTEGER,
            type TEXT DEFAULT 'transcript',
            FOREIGN KEY(meeting_id) REFERENCES meetings(id)
        )`);
    });
}

function addMeeting(user_id, bot_id) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare("INSERT INTO meetings (id, user_id, bot_id, created_at, process_state) VALUES (?, ?, ?, ?, ?)");
        const now = Date.now();
        stmt.run(bot_id, user_id, bot_id, now, 'initializing', function (err) {
            if (err) reject(err);
            else resolve({ id: bot_id });
        });
        stmt.finalize();
    });
}

function getMeeting(meeting_id) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM meetings WHERE id = ?", [meeting_id], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

/**
 * Stores the Meeting Encryption Key securely (Wrapped with Master Key).
 * @param {string} meeting_id 
 * @param {Buffer} rawKey 
 * @param {Buffer} fileIv - The File IV (not key IV)
 */
function storeMeetingKey(meeting_id, rawKey, fileIv) {
    return new Promise((resolve, reject) => {
        try {
            // 1. Wrap the Key
            const { encryptedBlob, iv: keyIv, authTag } = protectKey(rawKey);

            // We store the 'wrapper IV' + 'encrypted key' in one blob: "iv:key"
            const packedKey = `${keyIv}:${encryptedBlob}`;

            const stmt = db.prepare("INSERT OR REPLACE INTO meeting_keys (meeting_id, encrypted_key_blob, iv, auth_tag) VALUES (?, ?, ?, ?)");

            // Storing File IV in the 'iv' column
            stmt.run(meeting_id, packedKey, fileIv.toString('hex'), authTag, (err) => {
                if (err) reject(err);
                else resolve(true);
            });
            stmt.finalize();

        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Retrieves and Unwraps the Meeting Encryption Key.
 * @returns {Promise<{ key: Buffer, iv: Buffer }>}
 */
function getMeetingKey(meeting_id) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM meeting_keys WHERE meeting_id = ?", [meeting_id], (err, row) => {
            if (err) return reject(err);
            if (!row) return resolve(null);

            try {
                // unpack
                const [wrapperIv, encryptedKey] = row.encrypted_key_blob.split(':');
                const authTag = row.auth_tag;
                const fileIv = Buffer.from(row.iv, 'hex');

                const rawKey = unprotectKey(encryptedKey, wrapperIv, authTag);

                resolve({ key: rawKey, iv: fileIv });
            } catch (error) {
                console.error("Key Decryption Failed:", error);
                reject(new Error("Failed to unwrap key"));
            }
        });
    });
}

function updateMeetingId(old_id, new_id) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare("UPDATE meetings SET bot_id = ? WHERE id = ?");
        stmt.run(new_id, old_id, (err) => {
            if (err) reject(err);
            else resolve({ success: true });
        });
        stmt.finalize();
    });
}

function updateProcessState(meeting_id, state, file_paths, duration) {
    return new Promise((resolve, reject) => {
        let sql = "UPDATE meetings SET process_state = ?";
        const params = [state];

        if (file_paths) {
            sql += ", file_paths = ?";
            params.push(JSON.stringify(file_paths));
        }

        if (duration) {
            sql += ", duration_seconds = ?";
            params.push(duration);
        }

        sql += ", current_timestamp = ? WHERE id = ?";
        params.push(Date.now(), meeting_id);

        db.run(sql, params, (err) => {
            if (err) reject(err);
            else resolve(true);
        });
    });
}

// --- VERSIONING HELPERS ---

function addRevision(meetingId, version, hash, filePath, type = 'transcript') {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare("INSERT INTO transcript_revisions (meeting_id, version, content_hash, file_path, type, edited_at) VALUES (?, ?, ?, ?, ?, ?)");
        stmt.run(meetingId, version, hash, filePath, type, Date.now(), (err) => {
            if (err) reject(err);
            else resolve(true);
        });
        stmt.finalize();
    });
}

function getLatestVersion(meetingId, type = 'transcript') {
    return new Promise((resolve, reject) => {
        db.get("SELECT MAX(version) as max_ver FROM transcript_revisions WHERE meeting_id = ? AND type = ?", [meetingId, type], (err, row) => {
            if (err) reject(err);
            else resolve(row ? row.max_ver : 0);
        });
    });
}

function findRevisionByHash(hash) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM transcript_revisions WHERE content_hash = ?", [hash], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function getRevisions(meetingId, type = 'transcript') {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM transcript_revisions WHERE meeting_id = ? AND type = ? ORDER BY version DESC", [meetingId, type], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function getRevisionsByVersion(meetingId, version) {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM transcript_revisions WHERE meeting_id = ? AND version = ?", [meetingId, version], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function getRevision(id) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM transcript_revisions WHERE id = ?", [id], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function getUserMeetings(user_id) {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM meetings WHERE user_id = ? ORDER BY created_at DESC", [user_id], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

/**
 * Hard Deletes a meeting and all its associated data (keys, revisions).
 * Used when a meeting is invalid (e.g. no audio recorded).
 */


function checkoutToVersion(meetingId, version) {
    return new Promise((resolve, reject) => {
        // 1. Get Revision Paths
        db.all("SELECT * FROM transcript_revisions WHERE meeting_id = ? AND version = ?", [meetingId, version], (err, rows) => {
            if (err) return reject(err);
            if (!rows || rows.length === 0) return reject(new Error("Version not found"));

            // 2. Get Current Paths (to preserve audio)
            db.get("SELECT file_paths FROM meetings WHERE id = ?", [meetingId], (err2, meeting) => {
                if (err2) return reject(err2);

                let currentPaths = {};
                try {
                    if (meeting && meeting.file_paths) currentPaths = JSON.parse(meeting.file_paths);
                } catch (e) { }

                // 3. Construct New Paths
                let newPaths = { ...currentPaths }; // Clone to keep audio/others

                // Clear old transcript/summary first to ensure correctness? 
                // Or just overwrite.

                rows.forEach(r => {
                    if (r.type === 'transcript') newPaths.transcript = r.file_path;
                    if (r.type === 'summary') newPaths.summary = r.file_path;
                });

                // 4. Update Meeting
                const jsonPaths = JSON.stringify(newPaths);
                db.run("UPDATE meetings SET active_version = ?, file_paths = ? WHERE id = ?", [version, jsonPaths, meetingId], (err3) => {
                    if (err3) reject(err3);
                    else resolve({ success: true, version, newPaths });
                });
            });
        });
    });
}

function deleteMeeting(meeting_id) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            const cleanupKeys = db.prepare("DELETE FROM meeting_keys WHERE meeting_id = ?");
            const cleanupRevisions = db.prepare("DELETE FROM transcript_revisions WHERE meeting_id = ?");
            const cleanupMeta = db.prepare("DELETE FROM meetings WHERE id = ?");

            cleanupKeys.run(meeting_id);
            cleanupRevisions.run(meeting_id);
            cleanupMeta.run(meeting_id, function (err) {
                if (err) reject(err);
                else {
                    // Try to clean up physical files too if possible? 
                    // For now, Database cleanup is the priority to hide it from UI.
                    resolve(true);
                }
            });

            cleanupKeys.finalize();
            cleanupRevisions.finalize();
            cleanupMeta.finalize();
        });
    });
}

module.exports = {
    db,
    addMeeting,
    getMeeting,
    getUserMeetings,
    storeMeetingKey,
    getMeetingKey,
    updateMeetingId,
    updateProcessState,
    addRevision,
    getLatestVersion,
    findRevisionByHash,
    getRevisions,
    getRevision,
    getRevisionsByVersion,
    checkoutToVersion,
    deleteMeeting
};
