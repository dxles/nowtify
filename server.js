// Server.js - SON VE KESİN ÇÖZÜM

// .env.local dosyasını yüklüyoruz
import * as dotenv from 'dotenv';
dotenv.config({ path: `${process.cwd()}/.env.local` }); 

import express from 'express';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import querystring from 'querystring';
import cookieParser from 'cookie-parser'; // <<< KRİTİK EKLENTİ
import path from 'path';

// Express setup
const app = express();
const server = http.createServer(app);
const io = new SocketIO(server);

app.use(cookieParser()); // <<< KRİTİK: State_mismatch hatasını çözmek için
app.use(express.static(path.join(process.cwd(), 'public'))); 

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseKey) throw new Error('Supabase Key eksik!'); 
const supabase = createClient(supabaseUrl, supabaseKey);

// Spotify setup
const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const redirectUri = process.env.SPOTIFY_REDIRECT_URI; 

// YouTube setup
const ytKey = process.env.YT_KEY;

// Durum Yönetimi
const stateKey = 'spotify_auth_state';
let lastTrackUri = ''; 
let currentVideoId = null; 
let currentTrackTitle = '';

// Yardımcı Fonksiyon: Rastgele string oluşturma
const generateRandomString = length => {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
};

// YENİ FONKSİYON: Şarkıyı YouTube'da arar
async function searchYoutube(query) {
    if (!ytKey) return null;
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&key=${ytKey}&maxResults=1`;
    try {
        const response = await fetch(searchUrl);
        const data = await response.json();
        if (data.items && data.items.length > 0) {
            return data.items[0].id.videoId;
        }
        return null;
    } catch (e) {
        return null;
    }
}

// ------------------------------------------------------------------
// ROTASLAR
// ------------------------------------------------------------------

app.get('/', (req, res) => res.sendFile(path.join(process.cwd(), 'index.html')));

// Spotify Girişi
app.get('/login', (req, res) => {
    const state = generateRandomString(16);
    res.cookie(stateKey, state); 

    const scope = 'user-read-playback-state user-read-currently-playing'; 

    res.redirect('https://accounts.spotify.com/authorize?' +
        querystring.stringify({
            response_type: 'code',
            client_id: clientId,
            scope: scope,
            redirect_uri: redirectUri,
            state: state
        }));
});

// Spotify Callback 
app.get('/callback', async (req, res) => {
    const code = req.query.code || null;
    const state = req.query.state || null;
    const storedState = req.cookies ? req.cookies[stateKey] : null;

    if (state === null || state !== storedState) {
        // HATA DÜZELTME: State uyuşmazlığı durumunda ana sayfaya hata ile yönlendir
        return res.redirect('/?' + querystring.stringify({ error: 'state_mismatch' }));
    }

    res.clearCookie(stateKey); 

    const authOptions = {
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + (Buffer.from(clientId + ':' + clientSecret).toString('base64')),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: querystring.stringify({
            code: code,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
        })
    };

    try {
        // TOKEN DEĞİŞİMİ
        const response = await fetch('https://accounts.spotify.com/api/token', authOptions);
        const data = await response.json();
        
        if (!data.access_token) {
            return res.redirect('/?' + querystring.stringify({ error: 'invalid_token', reason: data.error_description || 'unknown_reason' }));
        }

        const accessToken = data.access_token;
        
        // Supabase'e Kaydet
        await supabase.from('users').upsert({
            spotify_id: 'main_user', 
            access_token: accessToken,
            updated_at: new Date().toISOString()
        }, { onConflict: 'spotify_id' }); 

        // Başarıyla ana sayfaya token ile yönlendir
        res.redirect('/?access_token=' + accessToken);

    } catch (error) {
        console.error("Callback hatası:", error);
        res.redirect('/?' + querystring.stringify({ error: 'server_error' }));
    }
});


// ------------------------------------------------------------------
// SOCKET.IO (SENKRONİZASYON)
// ------------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('statusUpdate', async (data) => {
    
    if (!data || !data.item || data.is_playing === false && data.progress_ms === 0) {
        io.emit('syncCommand', { command: 'stop' });
        lastTrackUri = ''; 
        currentVideoId = null;
        currentTrackTitle = '';
        return;
    }

    const track = data.item;
    const isPlaying = data.is_playing;
    const progressMs = data.progress_ms;
    const trackUri = track.uri;
    const trackTitle = `${track.artists.map(a=>a.name).join(', ')} - ${track.name}`;
    const albumImgUrl = track.album.images[0].url; 
    const durationMs = track.duration_ms;

    if (trackUri !== lastTrackUri) {
        lastTrackUri = trackUri;
        currentTrackTitle = trackTitle;
        
        const videoId = await searchYoutube(trackTitle);
        if (videoId) {
            currentVideoId = videoId;
            io.emit('syncCommand', { 
                command: 'load', 
                videoId: videoId,
                progress: progressMs, 
                trackTitle: trackTitle,
                albumImgUrl: albumImgUrl,
                duration: durationMs 
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

  socket.on('disconnect', () => {});
});

// Server'ı başlat
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));