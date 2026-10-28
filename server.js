const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cors = require('cors');
const JSZip = require('jszip');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Validate Credentials
if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    console.error("MISSING SPOTIFY CREDENTIALS. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in environment variables.");
    // We don't exit, but the app won't work without them.
}

// Helper: Get Spotify Token
async function getSpotifyToken() {
    try {
        const response = await axios.post('https://accounts.spotify.com/api/token', 
            new URLSearchParams({ grant_type: 'client_credentials' }),
            {
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64'),
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );
        return response.data.access_token;
    } catch (error) {
        throw new Error('Failed to authenticate with Spotify');
    }
}

// Helper: Search Spotify
async function searchSpotify(query, token) {
    const response = await axios.get(`https://api.spotify.com/v1/search`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { q: query, type: 'track', limit: 1 }
    });
    if (response.data.tracks.items.length === 0) throw new Error('Song not found on Spotify');
    return response.data.tracks.items[0];
}

// Helper: Get Album Tracks
async function getAlbumTracks(albumId, token) {
    const response = await axios.get(`https://api.spotify.com/v1/albums/${albumId}/tracks`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    return response.data.items;
}

// Helper: Get Album Info
async function getAlbumInfo(albumId, token) {
    const response = await axios.get(`https://api.spotify.com/v1/albums/${albumId}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
}

app.post('/download', async (req, res) => {
    const { input, mode } = req.body;
    const tempDir = path.join(__dirname, 'temp', Date.now().toString());
    fs.mkdirSync(tempDir, { recursive: true });

    try {
        if (!process.env.SPOTIFY_CLIENT_ID) {
            throw new Error("Server not configured with Spotify credentials.");
        }

        const token = await getSpotifyToken();
        let tracksToDownload = [];

        if (mode === 'album' || input.includes('/album/')) {
            // Extract album ID if URL is provided
            let albumId = null;
            const albumMatch = input.match(/album\/([a-zA-Z0-9]+)");
            if (albumMatch) {
                albumId = albumMatch[1];
            } else {
                // Search for album
                const searchRes = await axios.get(`https://api.spotify.com/v1/search`, {
                    headers: { Authorization: `Bearer ${token}` },
                    params: { q: input, type: 'album', limit: 1 }
                });
                if (searchRes.data.albums.items.length === 0) throw new Error('Album not found');
                albumId = searchRes.data.albums.items[0].id;
            }

            const albumInfo = await getAlbumInfo(albumId, token);
            const albumTracks = await getAlbumTracks(albumId, token); // This only gets first 50 usually, simplified for demo

            if (albumTracks.length === 0) throw new Error('No tracks found in album');

            // Create array of tasks
            tracksToDownload = albumTracks.items.map((track, index) => ({
                name: track.name,
                artist: track.artists[0].name,
                album: albumInfo.name,
                albumArt: albumInfo.images[0].url,
                trackNumber: track.track_number,
                query: `${track.name} ${track.artists[0].name}`
            }));

        } else {
            // Single Track
            const track = await searchSpotify(input, token);
            tracksToDownload = [{
                name: track.name,
                artist: track.artists[0].name,
                album: track.album.name,
                albumArt: track.album.images[0].url,
                trackNumber: 1,
                query: `${track.name} ${track.artists[0].name}`
            }));
        }

        // Process Downloads
        const downloadedFiles = [];
        for (const track of tracksToDownload) {
            const safeName = track.name.replace(/[^a-z0-9]/gi, '_');
            const filePath = path.join(tempDir, `${safeName}.mp3`);
            
            // Use yt-dlp to download audio only
            await new Promise((resolve, reject) => {
                const cmd = `yt-dlp --extract-audio --audio-format mp3 --output "${filePath}" "ytsearch1:${track.query}"`;
                exec(cmd, (error) => {
                    if (error) {
                        console.error("Download failed for", track.name, error);
                        reject(error);
                    } else {
                        // Metadata injection would go here (requires ffmpeg and complex tagging logic)
                        // For this simplified version, we just provide the raw file
                        downloadedFiles.push({ path: filePath, ...track });
                        resolve();
                    }
                });
            });
        }

        if (mode === 'album' || input.includes('/album/')) {
            // Create ZIP
            const zip = new JSZip();
            for (const file of downloadedFiles) {
                const content = fs.readFileSync(file.path);
                zip.file(`${file.name}.mp3`, content);
            }
            const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
            const zipPath = path.join(tempDir, 'album.zip');
            fs.writeFileSync(zipPath, zipBuffer);
            
            res.json({ success: true, message: 'Album ready', file: 'album.zip', path: tempDir });
            // Note: In a real app, you'd serve the file. Here we just confirm.
        } else {
            res.json({ success: true, message: 'Song ready', file: downloadedFiles[0].path });
        }

    } catch (error) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => {
    res.send('OK');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
