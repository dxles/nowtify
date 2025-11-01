// Server.js - SON VE KESİN ÇÖZÜM

// .env.local dosyasını yüklüyoruz
import * as dotenv from 'dotenv';
// KRİTİK DÜZELTME: Doğru yolu kullanarak .env.local dosyasını yüklüyoruz.
dotenv.config({ path: `${process.cwd()}/.env.local` });    

import express from 'express';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import querystring from 'querystring';
import cookieParser from 'cookie-parser'; 
import path from 'path';
import { fileURLToPath } from 'url';

// __dirname ve __filename simülasyonu
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Express setup
const app = express();
const server = http.createServer(app);
const io = new SocketIO(server);

app.use(cookieParser()); 

// KRİTİK DÜZELTME: index.html ve diğer statik dosyaların public klasöründen sunulmasını sağlar.
app.use(express.static(path.join(__dirname, 'public')));    

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseKey) {
    console.warn('UYARI: Supabase Key eksik veya hatalı.');
}
const supabase = createClient(supabaseUrl, supabaseKey);

// Spotify setup
const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const redirectUri = process.env.SPOTIFY_REDIRECT_URI;    

// YouTube setup
const youtubeApiKey = process.env.YOUTUBE_API_KEY;

// Global durum değişkenleri
let lastTrackUri = null;
let currentVideoId = null;
let currentTrackTitle = null;

const stateKey = 'spotify_auth_state';

/**
 * YouTube'da şarkıyı arama fonksiyonu
 */
async function searchYoutube(query) {
    // KRİTİK DÜZELTME: Gerçek YouTube API endpointi kullanılıyor.
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&key=${youtubeApiKey}&maxResults=1`;

    if (!youtubeApiKey) {
        console.error('YouTube API Key eksik. Arama yapılamıyor.');
        return null;
    }

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (!response.ok) {
            console.error(`YouTube API hatası (${response.status}):`, data);
            return null;
        }

        // İlk sonucu al ve video ID'sini döndür
        if (data.items && data.items.length > 0) {
            // Sadece video türündekini al
            const videoItem = data.items.find(item => item.id.kind === 'youtube#video');
            return videoItem ? videoItem.id.videoId : null;
        }
        return null;
    } catch (error) {
        console.error('YouTube araması başarısız oldu:', error.message);
        return null;
    }
}


/**
 * Spotify yetkilendirme akışı için rastgele string üretme
 */
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

    // KRİTİK DÜZELTME: Gerçek Spotify yetkilendirme URL'i kullanılıyor.
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
            // KRİTİK DÜZELTME: Node.js Buffer'ı ile Basic Auth oluşturma
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
            // KRİTİK DÜZELTME: Gerçek Spotify token URL'i kullanılıyor.
            const tokenRes = await fetch('https://accounts.spotify.com/api/token', authOptions);
            const tokenData = await tokenRes.json();
            
            const accessToken = tokenData.access_token;

            if (!accessToken) {
                console.error('Spotify, token döndüremedi:', tokenData);
                throw new Error('No access token received.');
            }

            // Başarılı. Access token ile ana sayfaya yönlendir. (Token HASH içinde)
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
 * SOCKET.IO Olay Yönetimi (KRİTİK BÖLÜM - Şarkı Değişim Gecikmesi Çözüldü)
 */
io.on('connection', (socket) => {
    console.log('Yeni bir istemci bağlandı.');

    socket.on('disconnect', () => {
        console.log('İstemci bağlantısı kesildi.');
    });

    // İstemciden Spotify durum güncellemelerini al
    socket.on('statusUpdate', async (data) => {
        
        // Şarkı çalma yoksa veya hata varsa
        if (!data || !data.item) {
            io.emit('syncCommand', { command: 'stop' });
            lastTrackUri = null;
            currentVideoId = null;
            currentTrackTitle = null;
            return;
        }

        // Gerekli verileri çıkar
        const track = data.item;
        const isPlaying = data.is_playing;
        const progressMs = data.progress_ms;
        const trackUri = track.uri;
        // Sanatçı ve Şarkı Adını birleştirme
        const trackTitle = `${track.artists.map(a=>a.name).join(', ')} - ${track.name}`; 
        const albumImgUrl = track.album.images[0].url;    
        const durationMs = track.duration_ms;

        // YENİ ŞARKI KONTROLÜ
        if (trackUri !== lastTrackUri) {
            
            // KRİTİK ÇÖZÜM: Yeni şarkı için YouTube'da arama yap.
            // Arama bitene kadar (eski) lastTrackUri'yi değiştirmeyiz, böylece
            // arama sırasında ekranda "Şarkı Oynatılamıyor" yazmaz.

            console.log(`Yeni şarkı tespit edildi: ${trackTitle}. YouTube aranıyor...`);
            const videoId = await searchYoutube(trackTitle);

            if (videoId) {
                // Arama başarılı, şimdi global durumu güncelle
                lastTrackUri = trackUri; 
                currentVideoId = videoId;
                currentTrackTitle = trackTitle;
                
                // 'load' komutu tüm gerekli verileri içerir
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
                // YouTube'da bulunamazsa, durdurma komutu gönder
                io.emit('syncCommand', { command: 'stop' });
                lastTrackUri = null; // URI'yı temizle ki tekrar aramayı denesin
                return;
            }
        }

        // PLAY/PAUSE DURUM GÜNCELLEMESİ (Sadece mevcut şarkının durumu değiştiyse)
        const basePayload = {
            progress: progressMs,
            duration: durationMs,
            trackTitle: trackTitle,    
            albumImgUrl: albumImgUrl,
            // Ekstra garanti
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
