const { ingestRecording } = require('./pipeline_manager');
const { updateProcessState, db } = require('./database');
const { getBotStatus, downloadAudio } = require('./recall');

const MEETING_ID = '3db9a224-ab18-41b1-9f53-84a8f1fc4a38';

async function repair() {
    console.log(`[Repair] Starting repair for ${MEETING_ID}...`);

    try {
        // 1. Reset Status in DB
        console.log('[Repair] Resetting DB status to initializing...');
        await updateProcessState(MEETING_ID, 'initializing');

        // 2. Clean up old keys (optional but good for hygiene)
        await new Promise((resolve, reject) => {
            const stmt = db.prepare("DELETE FROM meeting_keys WHERE meeting_id = ?");
            stmt.run(MEETING_ID, (err) => {
                if (err) reject(err);
                else resolve();
            });
            stmt.finalize();
        });
        console.log('[Repair] Cleared old keys.');

        // 3. Get Audio URL
        console.log('[Repair] Fetching fresh audio URL...');
        const status = await getBotStatus(MEETING_ID);
        if (!status.audio_ready) {
            console.error('[Repair] FAIL: Audio not ready on Recall.ai');
            process.exit(1);
        }

        // 4. Trigger Ingest
        console.log(`[Repair] Downloading audio from ${status.audio_url}`);
        const audioStream = await downloadAudio(status.audio_url);

        console.log('[Repair] Starting Pipeline Ingestion...');
        await ingestRecording(MEETING_ID, audioStream);

        console.log('[Repair] ✅ Repair Triggered Successfully. Watch logs for completion.');

    } catch (error) {
        console.error('[Repair] Error:', error);
    }
}

repair();
