const { db, getUserMeetings, deleteMeeting } = require('./database');

async function cleanup() {
    const ALLOWED_ID = '4e163f46';
    const userId = 'test-user'; // We might need to fetch all, or just hack it since we don't have user context easily in CLI without user_id. 
    // Actually, we can just query all meetings directly using db.all

    console.log(`[Cleanup] Keeping only meeting: ${ALLOWED_ID}`);

    db.all("SELECT id FROM meetings", async (err, rows) => {
        if (err) {
            console.error(err);
            return;
        }

        for (const row of rows) {
            if (row.id !== ALLOWED_ID) {
                console.log(`[Cleanup] Deleting ${row.id}...`);
                await deleteMeeting(row.id);
            } else {
                console.log(`[Cleanup] PRESERVING ${row.id}`);
            }
        }
        console.log("[Cleanup] Done.");
    });
}

cleanup();
