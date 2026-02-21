import functions from 'firebase-functions';

export const throwHttpsError = (code, message, details) => {
    throw new functions.https.HttpsError(code, message, details);
};
