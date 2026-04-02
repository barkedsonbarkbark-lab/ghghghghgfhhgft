const express = require('express');
const axios = require('axios');
const { Client, GatewayIntentBits } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. DISCORD BOT SETUP ---
// This part runs the actual bot listener
const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] 
});

// Log in using your Bot Token (Set this in Render Environment Variables!)
client.login(process.env.DISCORD_TOKEN);

client.once('ready', () => {
    console.log(`Bot is logged in as ${client.user.tag}`);
});

// --- 2. CONFIGURATION (From Render Env Vars) ---
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; 
const GUILD_ID = process.env.GUILD_ID; // Your Server ID
const ROLE_ID = process.env.ROLE_ID;   // The "Creator" Role ID

// --- 3. ROUTES ---

// Keep-Alive Route for Cron-job.org
app.get('/ping', (req, res) => {
    res.send('Bot is awake!');
});

// The OAuth2 Callback
app.get('/callback', async (req, res) => {
    const { code } = req.query;

    if (!code) return res.status(400).send('No code provided.');

    try {
        // Exchange Code for Access Token
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code: code,
            grant_type: 'authorization_code',
            redirect_uri: REDIRECT_URI,
            scope: 'identify connections',
        }));

        const accessToken = tokenResponse.data.access_token;

        // 1. Get User Info (to get their Discord ID)
        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const discordUserId = userResponse.data.id;

        // 2. Get User Connections
        const connectionsResponse = await axios.get('https://discord.com/api/users/@me/connections', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const connections = connectionsResponse.data;
        const hasSocial = connections.some(c => c.type === 'youtube' || c.type === 'tiktok');

        if (hasSocial) {
            // 3. Give the Role in the Server
            try {
                const guild = await client.guilds.fetch(GUILD_ID);
                const member = await guild.members.fetch(discordUserId);
                await member.roles.add(ROLE_ID);
                
                res.send('<h1>✅ Success!</h1><p>YouTube/TikTok found. You have been given the Creator Rank in the server!</p>');
            } catch (roleError) {
                console.error("Role Error:", roleError);
                res.send('<h1>⚠️ Semi-Success</h1><p>Verified, but I couldn\'t find you in the server to give the role. Make sure you are joined!</p>');
            }
        } else {
            res.send('<h1>❌ Failed</h1><p>No YouTube or TikTok account linked to your Discord. Link them in Discord Settings > Connections and try again.</p>');
        }

    } catch (error) {
        console.error("Auth Error:", error.response ? error.response.data : error.message);
        res.status(500).send('Authentication Error. Check server logs.');
    }
});

app.listen(PORT, () => console.log(`Web Server running on port ${PORT}`));
