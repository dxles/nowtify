// server.js



import express from 'express';

import fetch from 'node-fetch'; 

import { createServer } from 'http';

import { Server as SocketIoServer } from 'socket.io';

import dotenv from 'dotenv'; 

import { findLyrics } from 'lrclib-api';

import cookieParser from 'cookie-parser';

import { createClient } from '@supabase/supabase-js'; 



dotenv.config(); 



const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;

const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'https://nowtify.up.railway.app/callback'; 

const YOUTUBE_API_KEY = process.env.YT_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;

const SUPABASE_KEY = process.env.SUPABASE_KEY;

const PORT = process.env.PORT || 3000; 



const app = express();

const server = createServer(app);



const io = new SocketIoServer(server, {

    cors: {

        origin: "*", 

        methods: ["GET", "POST"]

    },

    transports: ['websocket', 'polling']

});



app.use(cookieParser());

app.use(express.static('public')); 



let lastTrackUri = '';



async function getLRC(trackTitle, durationMs) { 

    const parts = trackTitle.split(' - ');

    const artist = parts[0].trim();

    const title = parts.length > 1 ? parts[1].trim() : trackTitle.trim();



    const simpleArtist = artist.split(',')[0].trim().replace(/\s*\(feat\..*?\)/i, ''); 



    const searchQuery = {

        track_name: title,

        artist_name: simpleArtist,

    };



    try {

        const data = await findLyrics(searchQuery);



        if (data && data.id) {

            const bestMatch = data;

            

            if (bestMatch.syncedLyrics && !bestMatch.instrumental) {

                return bestMatch.syncedLyrics; 

            }

            

            if (bestMatch.plainLyrics && !bestMatch.instrumental) {

                 const lines = bestMatch.plainLyrics.split(/\r?\n/).filter(line => line.trim() !== '');

                 return lines.map(line => `[00:00.00]${line}`).join('\n'); 

            }

        }

        

        return `[00:01.00]Bu şarkı için LRC metni lrclib.net'te bulunamadı.`; 

        

    } catch (error) {

        console.error("LRC Çekme Hatası:", error.message);

        return `[00:01.00]LRC Lib servisiyle bağlantı kurulamadı.`;

    }

}



async function searchYoutube(query) {

if (!YOUTUBE_API_KEY) {

return null;

}



const apiUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query + ' official video')}&type=video&key=${YOUTUBE_API_KEY}&maxResults=1`;



try {

const response = await fetch(apiUrl);

if (!response.ok) {

return null;

}



const data = await response.json();



if (data.items && data.items.length > 0) {

const videoId = data.items[0].id.videoId;

return videoId;

} else {

return null;

}



} catch (error) {

return null;

}

}



app.get('/login', (req, res) => {

    if (!CLIENT_ID || !CLIENT_SECRET) {

        return res.status(500).send("Spotify API bilgileri yüklenemedi!");

    }

    

    const scope = 'user-read-playback-state';

    const authUrl = 'https://accounts.spotify.com/authorize?' +

        new URLSearchParams({

            response_type: 'code',

            client_id: CLIENT_ID,

            scope: scope,

            redirect_uri: REDIRECT_URI, 

        }).toString();

    res.redirect(authUrl);

});



app.get('/callback', async (req, res) => {

    const code = req.query.code || null;

    

    if (!code) {

         return res.redirect(`/?error=yetki_reddedildi`);

    }



    const authOptions = {

        method: 'POST',

        headers: {

            'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'), 

            'Content-Type': 'application/x-www-form-urlencoded'

        },

        body: new URLSearchParams({

            code: code,

            redirect_uri: REDIRECT_URI,

            grant_type: 'authorization_code'

        }).toString()

    };



    try {

        const tokenRes = await fetch('https://accounts.spotify.com/api/token', authOptions);

        const tokenData = await tokenRes.json();

        const accessToken = tokenData.access_token;

        

        res.redirect(`/?access_token=${accessToken}`);

        

    } catch (error) {

        res.send('Spotify Token Alma Hatası');

    }

});



app.get('/', (req, res) => {

    res.sendFile(process.cwd() + '/index.html');

});



async function fetchTrack(t) {

    const r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {

        headers: { Authorization: `Bearer ${t}` }

    });



    if (r.status === 204) return null;

    if (r.status === 401) {

        return null;

    }

    return await r.json();

}



io.on('connection', (socket) => {

    socket.on('statusUpdate', async (data) => {

        

        if (!data || !data.item || (data.is_playing === false && data.progress_ms === 0)) {

            io.emit('syncCommand', { command: 'stop' });

            lastTrackUri = '';

            return;

        }



        const track = data.item;

        const isPlaying = data.is_playing;

        const progressMs = data.progress_ms;

        const trackUri = track.uri;

        const trackTitle = `${track.artists.map(a=>a.name).join(', ')} - ${track.name}`;

        const durationMs = track.duration_ms;



        if (trackUri !== lastTrackUri) {

            lastTrackUri = trackUri;

            

            const lrcContent = await getLRC(trackTitle, durationMs); 

            const videoId = await searchYoutube(trackTitle);

            

            if (videoId) {

                io.emit('syncCommand', {

                    command: 'load',

                    videoId: videoId,

                    progress: progressMs,

                    trackTitle: trackTitle,

                    duration: durationMs,

                    lrc: lrcContent 

                });

                return;

            } else {

                io.emit('syncCommand', { command: 'stop', trackTitle: `YouTube'da bulunamadı: ${trackTitle}` });

                return;

            }

        }

        

        if (isPlaying) {

            io.emit('syncCommand', {

                command: 'play',

                progress: progressMs,

                duration: durationMs

            });

        } else {

            io.emit('syncCommand', {

                command: 'pause',

                progress: progressMs,

                duration: durationMs

            });

        }

    });



    socket.on('disconnect', () => {

    });

});



server.listen(PORT, () => {

});
