const admin = require('firebase-admin');
require('dotenv').config();
const path = require('path');

// Initialize Firebase Admin
// Expects GOOGLE_APPLICATION_CREDENTIALS in .env OR a 'serviceAccountKey.json' in root.

try {
    let serviceAccount;

    if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
        serviceAccount = {
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        };
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        serviceAccount = require(path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS));
    } else {
        // Fallback to local file
        try {
            serviceAccount = require('./serviceAccountKey.json');
        } catch (err) {
            console.warn("Attempted to load serviceAccountKey.json but it was missing.");
        }
    }

    if (!serviceAccount) {
        throw new Error("Firebase Service Account credentials are required. Set FIREBASE_PRIVATE_KEY and FIREBASE_CLIENT_EMAIL in .env");
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });

    console.log("Firebase Admin Initialized.");
} catch (error) {
    console.error("Firebase Admin Initialization Error:", error.message);
    // console.error("Make sure 'serviceAccountKey.json' exists or GOOGLE_APPLICATION_CREDENTIALS is set in .env");
}

module.exports = admin;
