const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
let ffmpegPath = null;
try {
    ffmpegPath = require('ffmpeg-static');
    console.log('Using ffmpeg from ffmpeg-static:', ffmpegPath);
} catch (e) {
    console.warn('ffmpeg-static not installed; falling back to system ffmpeg in PATH');
    ffmpegPath = 'ffmpeg';
}
const app = express();
const upload = multer({ limits: { fileSize: 1024 * 1024 * 500 } }); // 500MB limit

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.post('/convert', upload.single('file'), async (req, res) => {
    const format = req.body.format;
    const buffer = req.file.buffer;

    try {
        const convertedBuffer = await sharp(buffer)
            .toFormat(format)
            .toBuffer();

        res.type(`image/${format}`);
        res.send(convertedBuffer);
    } catch (error) {
        res.status(500).send('Conversion failed.');
    }
});

// Helper to write buffer to temp file
function writeTempFile(buffer, ext) {
    const tmpDir = os.tmpdir();
    const name = `upload-${Date.now()}-${Math.floor(Math.random()*10000)}.${ext}`;
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

// Map resolution preset to height and default bitrate
const resolutionMap = {
    '240p': {h:240, bitrate:'400k'},
    '360p': {h:360, bitrate:'800k'},
    '480p': {h:480, bitrate:'1500k'},
    '720p': {h:720, bitrate:'3000k'},
    '1080p': {h:1080, bitrate:'5000k'},
    '1440p': {h:1440, bitrate:'8000k'}
};

app.post('/transcode', upload.single('file'), async (req, res) => {
    // expected fields: format (mp4/webm/ogg), quality (e.g. '720p' or 'custom'), bitrate (if custom)
    console.log('POST /transcode received');
    console.log('req.file:', req.file ? 'present, size=' + req.file.size : 'missing');
    console.log('req.body:', req.body);
    
    if (!req.file) return res.status(400).send('No file uploaded');
    const format = 'mp4'; // hardcoded to MP4
    const quality = req.body.quality || '720p';
    
    console.log('Transcoding: format=mp4, quality=' + quality);

    const inputExt = (req.file.originalname || 'input').split('.').pop();
    const inputPath = writeTempFile(req.file.buffer, inputExt);
    const outName = `${path.parse(req.file.originalname).name}.${format}`;
    const outPath = path.join(os.tmpdir(), `out-${Date.now()}-${Math.floor(Math.random()*10000)}.${format}`);

    try {
        // build ffmpeg args for MP4 only
        const args = ['-y', '-i', inputPath];

        // determine scaling and bitrate based on quality
        const resMap = {
            '240p': {h:240, br:'400k'},
            '360p': {h:360, br:'800k'},
            '480p': {h:480, br:'1500k'},
            '720p': {h:720, br:'3000k'},
            '1080p': {h:1080, br:'5000k'},
            '1440p': {h:1440, br:'8000k'}
        };
        const res = resMap[quality] || resMap['720p'];
        
        args.push('-vf', `scale=-2:${res.h}`);
        args.push('-b:v', res.br);
        args.push('-c:v', 'libx264', '-preset', 'medium');
        args.push('-c:a', 'aac', '-b:a', '128k');
        args.push(outPath);

        console.log('Running ffmpeg with args:', args);

        const ff = spawn(ffmpegPath || 'ffmpeg', args);
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          ff.kill();
          console.error('FFmpeg timeout after 5 minutes');
        }, 5 * 60 * 1000);

        ff.stderr.on('data', (d) => console.log('ffmpeg:', d.toString().trim()));
        ff.on('error', (err) => {
          clearTimeout(timeout);
          console.error('ffmpeg spawn error', err);
        });

        ff.on('close', (code) => {
          clearTimeout(timeout);
          if (timedOut) {
            try { fs.unlinkSync(inputPath); } catch(e){}
            return res.status(500).send('Transcoding timed out (took more than 5 minutes)');
          }
          if (code !== 0) {
            console.error('FFmpeg exited with code', code);
            try { fs.unlinkSync(inputPath); } catch(e){}
            return res.status(500).send('FFmpeg error code ' + code);
          }

          try {
            const fileData = fs.readFileSync(outPath);
            res.type('video/mp4');
            res.send(fileData);
            // cleanup
            try { fs.unlinkSync(inputPath); } catch(e){}
            try { fs.unlinkSync(outPath); } catch(e){}
          } catch (err) {
            console.error('Error reading output file', err);
            res.status(500).send('Error reading output file');
          }
        });
    } catch (err) {
        try { fs.unlinkSync(inputPath); } catch(e){}
        try { fs.unlinkSync(outPath); } catch(e){}
        console.error(err);
        res.status(500).send('Transcoding failed.');
    }
});

// Audio extraction endpoint
app.post('/extract-audio', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded');
    const format = (req.body.format || 'mp3').toLowerCase();
    const inputExt = (req.file.originalname || 'input').split('.').pop();
    const inputPath = writeTempFile(req.file.buffer, inputExt);
    const outName = `${path.parse(req.file.originalname).name}.${format}`;
    const outPath = path.join(os.tmpdir(), `out-${Date.now()}-${Math.floor(Math.random()*10000)}.${format}`);

    try {
        let args = ['-y','-i', inputPath, '-vn'];
        if (format === 'mp3') args = args.concat(['-acodec','libmp3lame','-q:a','2', outPath]);
        else if (format === 'wav') args = args.concat(['-acodec','pcm_s16le','-ar','44100','-ac','2', outPath]);
        else if (format === 'ogg') args = args.concat(['-acodec','libvorbis','-q:a','5', outPath]);
        else args = args.concat(['-c:a','copy', outPath]);

        const ff = spawn(ffmpegPath || 'ffmpeg', args);
        ff.stderr.on('data', (d) => console.log('ffmpeg:', d.toString()));
        ff.on('error', (err) => console.error('ffmpeg spawn error', err));
        ff.on('close', (code) => {
            if (code !== 0) {
                try { fs.unlinkSync(inputPath); } catch(e){}
                return res.status(500).send('Audio extraction failed (ffmpeg error code ' + code + ')');
            }
            const fileData = fs.readFileSync(outPath);
            res.type('audio/' + format);
            res.send(fileData);
            // cleanup
            try { fs.unlinkSync(inputPath); } catch(e){}
            try { fs.unlinkSync(outPath); } catch(e){}
        });
    } catch (err) {
        try { fs.unlinkSync(inputPath); } catch(e){}
        try { fs.unlinkSync(outPath); } catch(e){}
        console.error(err);
        res.status(500).send('Audio extraction failed.');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`File Converter server running on http://localhost:${PORT}`);
});
