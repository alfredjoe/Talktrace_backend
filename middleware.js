const admin = require('./firebaseAdmin');

async function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Unauthorized: No token provided" });
    }

    const token = authHeader.split(' ')[1];

    try {
        if (admin && admin.apps && admin.apps.length > 0) {
            const decodedToken = await admin.auth().verifyIdToken(token);
            req.user = decodedToken; // Contains uid, email, etc.
        } else {
            // Fallback for local development if Firebase Admin is not initialized
            const payloadBase64 = token.split('.')[1];
            if (!payloadBase64) {
                throw new Error("Invalid JWT token format");
            }
            const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString());
            req.user = {
                uid: payload.user_id || payload.sub || "mock-user-id",
                email: payload.email || "mock@example.com",
                ...payload
            };
            console.warn(`[Dev Warning] Decoded token without signature verification (local development mode). User UID: ${req.user.uid}`);
        }
        next();
    } catch (error) {
        console.error("Token verification failed:", error.message);
        return res.status(403).json({ error: "Unauthorized: Invalid token" });
    }
}

module.exports = verifyToken;
