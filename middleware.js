const admin = require('./firebaseAdmin');

async function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Unauthorized: No token provided" });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken; // Contains uid, email, etc.
        next();
    } catch (error) {
        console.error("Token verification failed:", error.message);
        return res.status(403).json({ error: "Unauthorized: Invalid token" });
    }
}

module.exports = verifyToken;
