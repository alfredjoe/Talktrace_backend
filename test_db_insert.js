const { addMeeting } = require('./database');

async function testInsert() {
    try {
        console.log("Testing addMeeting...");
        const result = await addMeeting("test_user_id", "test_bot_id_123");
        console.log("Insert Successful! Result:", result);
    } catch (error) {
        console.error("Insert Failed!", error);
    }
}

testInsert();
