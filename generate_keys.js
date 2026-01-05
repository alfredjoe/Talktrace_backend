const NodeRSA = require('node-rsa');

console.log("Generating 2048-bit RSA Key Pair...");

const key = new NodeRSA({ b: 2048 });

const publicKey = key.exportKey('pkcs8-public');
const privateKey = key.exportKey('pkcs8-private');

console.log("\n--- COPY THIS INTO YOUR .env FILE (FRONTEND_PUBLIC_KEY) ---");
console.log(publicKey);
console.log("-----------------------------------------------------------\n");

console.log("--- SAVE THIS FOR YOUR FRONTEND (Private Key) ---");
console.log(privateKey);
console.log("-------------------------------------------------\n");

console.log("Done! The 'Public Key' goes to the backend (.env). The 'Private Key' stays in your Frontend code to decrypt.");
