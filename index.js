const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const CLIENT_ID = '1488044843790897162';
const CLIENT_SECRET = 'gh0w76O7CniVGOFA6USNdWVB-7_oAmVx';
const REDIRECT_URI = 'https://ghghghghgfhhgft.onrender.com/callback';

// This variable stores the last token received in memory
let lastReceivedToken = "No token received yet.";

// 1. Keep-Alive
app.get('/ping', (req, res) => res.send('Bot is awake!'));

// 2. THE NEW ENDPOINT: View the token
app.get('/token', (req, res) => {
    res.send(`<h1>Latest Token:</h1><code>${lastReceivedToken}</code>`);
});

// 3. The OAuth2 Callback
app.get('/callback', async (req, res) => {
    const { code } = req.query;

    if (!code) return res.status(400).send('No code provided.');

    try {
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code: code,
            grant_type: 'authorization_code',
            redirect_uri: REDIRECT_URI,
        }));

        // SAVE THE TOKEN TO OUR VARIABLE
        lastReceivedToken = tokenResponse.data.access_token;

        res.send('<h1>✅ Success!</h1><p>Token captured. You can now view it at <b>/token</b></p>');
    } catch (error) {
        res.status(500).send('Error exchanging code.');
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
