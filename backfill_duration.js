const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const { db, getMeetingKey, updateProcessState, getUserMeetings } = require('./database');
const { getDecryptedStream } = require('./storage_enc');
const { ensureStorage } = require('./storage_enc');

const AUDIO_DIR = path.join(__dirname, 'storage_vault', 'audio');

async function backfill() {
    console.log("Starting Duration Backfill...");

    // Get all meetings
    db.all("SELECT id, user_id, process_state FROM meetings WHERE duration_seconds = 0 OR duration_seconds IS NULL", async (err, rows) => {
        if (err) return console.error("DB Error:", err);

        console.log(`Found ${rows.length} meetings to check.`);

        for (const row of rows) {
            if (row.process_state !== 'completed' && row.process_state !== 'downloaded') continue;

            console.log(`Processing ${row.id}...`);

            try {
                // 1. Get Key
                const keyData = await getMeetingKey(row.id);
                if (!keyData) {
                    console.log(`Skipping ${row.id}: No key found.`);
                    continue;
                }

                const encPath = path.join(AUDIO_DIR, `${row.id}.enc`);
                if (!fs.existsSync(encPath)) {
                    console.log(`Skipping ${row.id}: Audio file not found.`);
                    continue;
                }

                // 2. Decrypt to Temp
                const tempPath = path.join(os.tmpdir(), `${row.id}_temp_probe.mp3`);
                const output = fs.createWriteStream(tempPath);
                const decryptStream = getDecryptedStream(encPath, keyData.key, keyData.iv);

                await new Promise((resolve, reject) => {
                    decryptStream.pipe(output);
                    output.on('finish', resolve);
                    output.on('error', reject);
                });

                // 3. Probe
                const duration = await new Promise((resolve) => {
                    ffmpeg.ffprobe(tempPath, (err, metadata) => {
                        if (err) resolve(0);
                        else resolve(Math.round(metadata.format.duration));
                    });
                });

                console.log(`Duration for ${row.id}: ${duration}s`);

                // 4. Update DB
                if (duration > 0) {
                    // We need to keep existing file_paths. Retrieve them first or use a targeted update?
                    // updateProcessState overwrites file_paths if we aren't careful?
                    // My updateProcessState implementation expects file_paths if I want to update them, 
                    // OR I can use a raw update query here to be safe.
                    await new Promise((resolve, reject) => {
                        db.run("UPDATE meetings SET duration_seconds = ? WHERE id = ?", [duration, row.id], (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                    console.log("Updated DB.");
                }

                // Cleanup
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

            } catch (error) {
                console.error(`Error processing ${row.id}:`, error.message);
            }
        }
        console.log("Backfill Complete.");
    });
}

backfill();
