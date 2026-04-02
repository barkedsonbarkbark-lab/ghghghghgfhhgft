const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 10000;

// --- CONFIG ---
const CLIENT_ID = '1488044843790897162';
const CLIENT_SECRET = 'gh0w76O7CniVGOFA6USNdWVB-7_oAmVx'; // Reset this in Discord Dev Portal!
const REDIRECT_URI = 'https://ghghghghgfhhgft.onrender.com/callback';

// Memory storage for the tokens
let tokenDatabase = {}; 

app.get('/ping', (req, res) => res.send('Token Server Online'));

// 1. The Callback: Discord sends the user here
app.get('/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('No code provided.');

    try {
        const response = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code: code,
            grant_type: 'authorization_code',
            redirect_uri: REDIRECT_URI,
        }));

        const accessToken = response.data.access_token;

        // Fetch User ID so we know whose token this is
        const userRes = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        // Store it: key = User ID, value = Token
        tokenDatabase[userRes.data.id] = accessToken;

        res.send('<h1>✅ Linked!</h1><p>You can now go back to Discord and use /creatorrank.</p>');
    } catch (err) {
        res.status(500).send('Auth Error. Check Client Secret.');
    }
});

// 2. The Fetcher: Your Bot calls this to get a user's token
app.get('/get-token/:userId', (req, res) => {
    const token = tokenDatabase[req.params.userId];
    if (token) {
        res.json({ token: token });
    } else {
        res.status(404).json({ error: 'Token not found for this user.' });
    }
});

app.listen(PORT, () => console.log(`Token Catcher running on port ${PORT}`));
