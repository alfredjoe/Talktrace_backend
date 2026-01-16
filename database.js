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
            file_paths TEXT
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

function updateProcessState(meeting_id, state, file_paths) {
    return new Promise((resolve, reject) => {
        let sql = "UPDATE meetings SET process_state = ?";
        const params = [state];

        if (file_paths) {
            sql += ", file_paths = ?";
            params.push(JSON.stringify(file_paths));
        }

        sql += " WHERE id = ?";
        params.push(meeting_id);

        db.run(sql, params, (err) => {
            if (err) reject(err);
            else resolve(true);
        });
    });
}

// --- VERSIONING HELPERS ---

function addRevision(meetingId, version, hash, filePath) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare("INSERT INTO transcript_revisions (meeting_id, version, content_hash, file_path, edited_at) VALUES (?, ?, ?, ?, ?)");
        stmt.run(meetingId, version, hash, filePath, Date.now(), (err) => {
            if (err) reject(err);
            else resolve(true);
        });
        stmt.finalize();
    });
}

function getLatestVersion(meetingId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT MAX(version) as max_ver FROM transcript_revisions WHERE meeting_id = ?", [meetingId], (err, row) => {
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

module.exports = {
    db,
    addMeeting,
    getMeeting,
    storeMeetingKey,
    getMeetingKey,
    updateMeetingId,
    updateProcessState,
    addRevision,
    getLatestVersion,
    findRevisionByHash
};
