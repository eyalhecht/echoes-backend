const functions = require('firebase-functions');

// Updated Hello World function with proper CORS
exports.helloWorld = functions.https.onRequest((request, response) => {
    // Handle CORS
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight OPTIONS request
    if (request.method === 'OPTIONS') {
        response.status(204).send('');
        return;
    }

    response.json({
        message: "Hello from echoes-backend!",
        timestamp: new Date().toISOString(),
        method: request.method,
        path: request.path,
        origin: request.get('origin') || 'unknown'
    });
});

// Keep your health function as is
exports.health = functions.https.onRequest((request, response) => {
    response.set('Access-Control-Allow-Origin', '*');
    response.json({
        status: "OK",
        service: "echoes-backend",
        timestamp: new Date().toISOString()
    });
});
