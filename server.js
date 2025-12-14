import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(express.static('public'));
app.use(express.json());

// Oda oluştur ve Supabase'e ekle
app.post('/create-room', async (req, res) => {
    const { data, error } = await supabase
        .from('rooms')
        .insert({})
        .select();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ roomId: data[0].id });
});

// Odaya katılma
app.get('/room/:id', async (req, res) => {
    const roomId = req.params.id;
    const { data, error } = await supabase
        .from('rooms')
        .select()
        .eq('id', roomId)
        .single();
    if (error || !data) return res.status(404).send('Oda bulunamadı');
    res.sendFile(new URL('./public/room.html', import.meta.url).pathname);
});

// Socket.io
io.on('connection', socket => {
    socket.on('join-room', roomId => {
        socket.join(roomId);
        socket.to(roomId).emit('user-connected', socket.id);

        socket.on('signal', data => {
            io.to(data.to).emit('signal', { from: socket.id, signal: data.signal });
        });

        socket.on('disconnect', () => {
            socket.to(roomId).emit('user-disconnected', socket.id);
        });
    });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
