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
import cookieParser from 'cookie-parser'; // KRİTİK EKLENTİ
import path from 'path';

// Express setup
const app = express();
const server = http.createServer(app);
const io = new SocketIO(server);

app.use(cookieParser()); // KRİTİK: State_mismatch hatasını çözmek için
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
const youtubeApiKey = process.env.YOUTUBE_API_KEY;

// Global durum değişkenleri
let lastTrackUri = null;
let currentVideoId = null;
let currentTrackTitle = null;

// Spotify akışını dinlemek için yeni bir rota aç
const stateKey = 'spotify_auth_state';

/**
 * YouTube'da şarkıyı arama fonksiyonu
 */
async function searchYoutube(query) {
    const url = `http://googleusercontent.com/youtube/3`; // API endpointi düzeltildi

    try {
        const response = await fetch(url);
        const data = await response.json();

        // İlk sonucu al ve video ID'sini döndür
        if (data.items && data.items.length > 0) {
            return data.items[0].id.videoId;
        }
        return null;
    } catch (error) {
        console.error('YouTube araması başarısız oldu:', error.message);
        return null;
    }
}


/**
 * Spotify yetkilendirme akışı
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
    // state_mismatch hatası, client'ı /#error=state_mismatch adresine yönlendir.
    res.clearCookie(stateKey);
    res.redirect('/?error=' + querystring.stringify({
      error: 'state_mismatch'
    }));
  } else {
    res.clearCookie(stateKey);
    const authOptions = {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + (new Buffer.from(clientId + ':' + clientSecret).toString('base64')),
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

      // Başarılı. Access token ile ana sayfaya yönlendir.
      res.redirect('/#' + querystring.stringify({
          access_token: accessToken
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
 * SOCKET.IO Olay Yönetimi (KRİTİK BÖLÜM)
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
    const trackTitle = `${track.artists.map(a=>a.name).join(', ')} - ${track.name}`;
    const albumImgUrl = track.album.images[0].url; 
    const durationMs = track.duration_ms;

    // YENİ ŞARKI KONTROLÜ
    if (trackUri !== lastTrackUri) {
        lastTrackUri = trackUri;
        currentTrackTitle = trackTitle;
        
        const videoId = await searchYoutube(trackTitle);
        if (videoId) {
            currentVideoId = videoId;
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
            io.emit('syncCommand', { command: 'stop', trackTitle: `YouTube'da bulunamadı: ${trackTitle}` });
            return;
        }
    }

    // PLAY/PAUSE DURUM GÜNCELLEMESİ (KRİTİK GÜNCELLEME)
    // Her play/pause komutunda tüm görsel verileri yeniden gönderiyoruz. 
    // Bu, istemcinin görsel tutarlılığını garanti eder.
    const basePayload = {
        progress: progressMs,
        duration: durationMs,
        trackTitle: trackTitle,   // KRİTİK: EKLENDİ
        albumImgUrl: albumImgUrl  // KRİTİK: EKLENDİ
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


// Index.html'i sun
app.get('/', (req, res) => {
  // Bu durumda, index.html'i public klasöründen sunuyoruz
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// Sunucuyu başlat
const port = process.env.PORT || 8888;
server.listen(port, () => {
  console.log(`Nowtify sunucusu http://localhost:${port} adresinde çalışıyor`);
});
