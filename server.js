// Server.js - SON VE KESİN ÇÖZÜM (Supabase ve Tüm Bileşenler Entegre Edildi)

import * as dotenv from 'dotenv';
dotenv.config({ path: `${process.cwd()}/.env.local` });    

import express from 'express';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js'; // SUPABASE GEREKLİ
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import querystring from 'querystring';
import cookieParser from 'cookie-parser'; 
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server);

app.use(cookieParser()); 
app.use(express.static(path.join(__dirname, 'public')));    

// API Anahtarları
const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const redirectUri = process.env.SPOTIFY_REDIRECT_URI;    
const youtubeApiKey = process.env.YOUTUBE_API_KEY;

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

// Hata kontrolü: Supabase key'leri eksikse, bağlantı null kalır, ama uygulama devam eder.
if (!supabaseKey || !supabaseUrl) {
    console.warn('UYARI: Supabase Key veya URL eksik. YouTube önbelleklemesi (caching) KULLANILMAYACAK.');
}
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null; 


// Global durum değişkenleri
let lastTrackUri = null;
let currentVideoId = null;
let currentTrackTitle = null;

const stateKey = 'spotify_auth_state';

/**
 * YouTube'da şarkıyı arama ve Supabase'den önbellek kontrolü
 */
async function searchYoutube(query, trackId) {
    if (supabase) {
        // 1. Supabase'den önbelleği kontrol et
        try {
            const { data, error } = await supabase
                .from('youtube_cache')
                .select('video_id')
                .eq('track_id', trackId)
                .single();

            if (data && data.video_id) {
                console.log(`[SUPABASE] Önbellekten bulundu: ${trackId}`);
                return data.video_id;
            }
        } catch (error) {
            // Önbellek okuma hatası olsa bile aramaya devam etmeli
            // console.error('[SUPABASE] Önbellek okuma hatası:', error.message);
        }
    }


    // 2. YouTube API ile ara
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&key=${youtubeApiKey}&maxResults=1`;

    if (!youtubeApiKey) {
        console.error('YouTube API Key eksik. Arama yapılamıyor.');
        return null;
    }

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (!response.ok) {
            // 403 (Kota) veya 400 (Yanlış istek) gibi hataları yakalar
            console.error(`YouTube API hatası (${response.status}):`, data.error ? data.error.message : 'Bilinmeyen Hata');
            return null;
        }

        if (data.items && data.items.length > 0) {
            const videoItem = data.items.find(item => item.id.kind === 'youtube#video');
            const videoId = videoItem ? videoItem.id.videoId : null;

            if (videoId && supabase) {
                // 3. Supabase'e sonucu kaydet
                try {
                    const { error } = await supabase
                        .from('youtube_cache')
                        .insert([
                            { track_id: trackId, track_title: query, video_id: videoId }
                        ]);
                    if (error) throw error;
                    console.log(`[SUPABASE] Yeni sonuç önbelleğe kaydedildi: ${trackId}`);
                } catch (error) {
                    // Kayıt hatası önemli değil, senkronizasyon devam etmeli
                    // console.error('[SUPABASE] Önbellek yazma hatası:', error.message);
                }
            }
            return videoId;
        }
        return null;
    } catch (error) {
        console.error('YouTube araması başarısız oldu:', error.message);
        return null;
    }
}


const generateRandomString = (length) => {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
};


app.get('/login', (req, res) => {
    if (!clientId || !clientSecret || !redirectUri) {
         return res.status(500).send("Lütfen .env.local dosyasındaki Spotify kimlik bilgilerini kontrol edin.");
    }
    
    const state = generateRandomString(16);
    res.cookie(stateKey, state);

    const scope = 'user-read-playback-state';

    res.redirect('https://accounts.spotify.com/authorize?' +
        querystring.stringify({
            response_type: 'code',
            client_id: clientId,
            scope: scope,
            redirect_uri: redirectUri,
            state: state
        }));
});


app.get('/callback', async (req, res) => {
    const code = req.query.code || null;
    const state = req.query.state || null;
    const storedState = req.cookies ? req.cookies[stateKey] : null;

    if (state === null || state !== storedState) {
        res.clearCookie(stateKey);
        res.redirect('/?error=' + querystring.stringify({
            error: 'state_mismatch'
        }));
    } else {
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
            const tokenRes = await fetch('https://accounts.spotify.com/api/token', authOptions);
            const tokenData = await tokenRes.json();
            
            const accessToken = tokenData.access_token;

            if (!accessToken) {
                console.error('Spotify, token döndüremedi:', tokenData);
                throw new Error('No access token received.');
            }

            res.redirect('/#' + querystring.stringify({
                access_token: accessToken,
                expires_in: tokenData.expires_in 
            }));

        } catch (error) {
            console.error('Token alma hatası:', error);
            res.redirect('/?error=' + querystring.stringify({
                error: 'invalid_token'
            }));
        }
    }
});


/**
 * SOCKET.IO Olay Yönetimi 
 */
io.on('connection', (socket) => {
    console.log('Yeni bir istemci bağlandı.');

    socket.on('disconnect', () => {
        console.log('İstemci bağlantısı kesildi.');
    });

    socket.on('statusUpdate', async (data) => {
        
        if (data && data.item) {
            console.log(`[SUNUCU LOG] Spotify verisi alındı. Şarkı: ${data.item.name}.`);
        } else {
            console.log('[SUNUCU LOG] Spotify verisi alındı: Çalmıyor/Boş.');
        }

        if (!data || !data.item) {
            io.emit('syncCommand', { command: 'stop' });
            lastTrackUri = null;
            currentVideoId = null;
            currentTrackTitle = null;
            return;
        }

        const track = data.item;
        const isPlaying = data.is_playing;
        const progressMs = data.progress_ms;
        const trackUri = track.uri;
        const trackTitle = `${track.artists.map(a=>a.name).join(', ')} - ${track.name}`; 
        const albumImgUrl = track.album.images[0].url;    
        const durationMs = track.duration_ms;
        const trackId = track.id; // Supabase/Cache için track ID

        // YENİ ŞARKI KONTROLÜ
        if (trackUri !== lastTrackUri) {
            
            console.log(`Yeni şarkı tespit edildi: ${trackTitle}. YouTube aranıyor (Önbellek Kontrolü Dahil)...`);
            
            // Supabase entegreli arama fonksiyonu
            const videoId = await searchYoutube(trackTitle, trackId); 

            if (videoId) {
                lastTrackUri = trackUri; 
                currentVideoId = videoId;
                currentTrackTitle = trackTitle;
                
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
                console.log(`UYARI: YouTube araması başarısız oldu veya video bulunamadı: ${trackTitle}. Şarkı bilgisi gönderilmiyor.`);
                io.emit('syncCommand', { command: 'stop' });
                lastTrackUri = null; 
                return;
            }
        }

        // PLAY/PAUSE DURUM GÜNCELLEMESİ
        const basePayload = {
            progress: progressMs,
            duration: durationMs,
            trackTitle: trackTitle,    
            albumImgUrl: albumImgUrl,
            videoId: currentVideoId 
        };

        if (isPlaying) {
            io.emit('syncCommand', {    
                command: 'play',
                ...basePayload
            });
        } else {
            io.emit('syncCommand', {    
                command: 'pause',
                ...basePayload
            });
        }
    });
});


// Sunucuyu başlat
const port = process.env.PORT || 8888;
server.listen(port, () => {
    console.log(`Nowtify sunucusu http://localhost:${port} adresinde çalışıyor`);
});
