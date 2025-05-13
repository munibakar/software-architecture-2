const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const { createServer } = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// FFmpeg yapılandırması - alternatif yaklaşım
const ffmpegPath = path.join(__dirname, "ffmpeg.exe");
console.log(`FFmpeg yolu: ${ffmpegPath}`);
console.log(`FFmpeg dosyası mevcut: ${fs.existsSync(ffmpegPath)}`);
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/audio', express.static(path.join(__dirname, 'audio')));

// Frontend dosyalarını sun
app.use(express.static(path.join(__dirname, '../frontend')));

// Ana sayfa için route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Klasörleri oluşturma
const uploadsDir = path.join(__dirname, 'uploads');
const audioDir = path.join(__dirname, 'audio');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);

// Dosya yükleme konfigürasyonu
const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function(req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
  fileFilter: function(req, file, cb) {
    // Video dosyaları için filtre
    if (file.fieldname === 'video') {
      const filetypes = /mp4|avi|mov|mkv|webm/;
      const mimetype = filetypes.test(file.mimetype);
      const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
      
      if (mimetype && extname) {
        return cb(null, true);
      }
      cb(new Error('Sadece video dosyaları yüklenebilir!'));
    } 
    // Text dosyaları için filtre
    else if (file.fieldname === 'textFile') {
      const filetypes = /text\/plain/;
      const mimetype = filetypes.test(file.mimetype);
      const extname = /\.txt$/.test(path.extname(file.originalname).toLowerCase());
      
      if (mimetype && extname) {
        return cb(null, true);
      }
      cb(new Error('Sadece .txt uzantılı metin dosyaları yüklenebilir!'));
    }
    else {
      cb(new Error('Beklenmeyen dosya alanı!'));
    }
  }
});

// Socket.io bağlantı yönetimi
io.on('connection', (socket) => {
  console.log('Bir istemci bağlandı: ' + socket.id);
  
  socket.on('disconnect', () => {
    console.log('İstemci bağlantısı kesildi: ' + socket.id);
  });
});

// Model servisi URL'i
// Log çıktılarında görünen IP adreslerinden birini kullanalım
// 127.0.0.1 (localhost) yerine 192.168.1.107 IP adresini deneyelim
// NOT: Model servisi farklı bir bilgisayarda çalışıyorsa, o bilgisayarın IP adresi kullanılmalıdır
const MODEL_SERVICE_URL = 'http://127.0.0.1:5000';
// const MODEL_SERVICE_URL = 'http://192.168.1.107:5000'; // Alternatif IP

// Rotalar
app.get('/api/test-model', async (req, res) => {
  try {
    console.log('Model servisi test ediliyor...');
    const response = await axios.get(`${MODEL_SERVICE_URL}/api/test`);
    console.log('Model servisi yanıtı:', response.data);
    res.status(200).json({
      success: true,
      message: 'Model servisi ile iletişim kuruldu',
      model_response: response.data
    });
  } catch (error) {
    console.error('Model servisi test hatası:', error.message);
    res.status(500).json({
      success: false,
      message: 'Model servisi ile iletişim kurulamadı',
      error: error.message
    });
  }
});

app.post('/api/upload', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'textFile', maxCount: 1 }
]), async (req, res) => {
  try {
    if (!req.files || !req.files.video) {
      return res.status(400).json({ error: 'Video dosyası yüklenemedi' });
    }
    
    const videoFile = req.files.video[0];
    const videoPath = videoFile.path;
    const videoFilename = videoFile.filename;
    const audioFilename = path.basename(videoFilename, path.extname(videoFilename)) + '.mp3';
    const audioPath = path.join(audioDir, audioFilename);
    
    // Text dosyası varsa bilgisini al
    let textFilePath = null;
    if (req.files.textFile && req.files.textFile.length > 0) {
      const textFile = req.files.textFile[0];
      textFilePath = textFile.path;
      io.emit('processingUpdate', { 
        status: 'info', 
        message: 'Text file uploaded, will be used for summary enhancement'
      });
    }
    
    // İşleme başladığına dair bilgi gönder
    io.emit('processingUpdate', { status: 'started', message: 'Video uploaded, audio extraction begins...' });
    
    // Video'dan ses ayıklama
    await extractAudioFromVideo(videoPath, audioPath);
    
    io.emit('processingUpdate', { 
      status: 'audioExtracted', 
      message: 'Audio extracted, sending to Whisper model...',
      audioPath: `/audio/${audioFilename}`,
      videoPath: `/uploads/${videoFilename}`
    });
    
    res.status(200).json({ 
      message: 'Video successfully uploaded and processed',
      videoId: path.basename(videoFilename, path.extname(videoFilename)),
      videoPath: `/uploads/${videoFilename}`,
      audioPath: `/audio/${audioFilename}`,
      textFilePath: textFilePath ? textFilePath.replace(/\\/g, '/') : null
    });
    
  } catch (error) {
    console.error('Hata:', error);
    io.emit('processingUpdate', { status: 'error', message: 'İşlem sırasında hata: ' + error.message });
    res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
  }
});

app.post('/api/process', async (req, res) => {
  try {
    const { audioPath, textFilePath } = req.body;
    
    if (!audioPath) {
      return res.status(400).json({ error: 'Ses dosyası yolu belirtilmedi' });
    }
    
    const fullAudioPath = path.join(__dirname, audioPath);
    
    if (!fs.existsSync(fullAudioPath)) {
      return res.status(404).json({ error: 'Ses dosyası bulunamadı' });
    }
    
    io.emit('processingUpdate', { status: 'modelProcessing', message: 'Model processing begins...' });
    
    try {
      // Debug için log ekleyelim
      console.log('--------------------------------------------------');
      console.log(`Model servisine istek gönderiliyor: ${MODEL_SERVICE_URL}/api/process`);
      console.log(`Ses dosyası yolu: ${fullAudioPath}`);
      
      // Veriyi hazırla
      const requestData = {
        audio_path: fullAudioPath.replace(/\\/g, '/')
      };
      
      // Text dosyası varsa ekle
      if (textFilePath) {
        const fullTextPath = path.join(__dirname, textFilePath);
        if (fs.existsSync(fullTextPath)) {
          requestData.text_file_path = fullTextPath.replace(/\\/g, '/');
          console.log(`Metin dosyası yolu: ${requestData.text_file_path}`);
        } else {
          console.log(`Metin dosyası bulunamadı: ${fullTextPath}`);
        }
      }
      
      console.log('Gönderilen veri:', JSON.stringify(requestData));
      
      // Sınama amaçlı bir CURL komutu gösterelim
      console.log(`Test için CURL komutu: curl -X POST ${MODEL_SERVICE_URL}/api/process -H "Content-Type: application/json" -d '${JSON.stringify(requestData)}'`);
      
      // Gerçek API çağrısını yap - doğrudan axios ile
      const modelResponse = await axios({
        method: 'post',
        url: `${MODEL_SERVICE_URL}/api/process`,
        data: requestData,
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000 // 60 saniye timeout (daha uzun sürebilir)
      });
      
      console.log('Model servisinden yanıt:', modelResponse.data);
      
      // Gerçek jobId
      const jobId = modelResponse.data.job_id;
      
      // Kullanıcıya işlem ID'sini dön
      res.status(200).json({
        message: 'İşlem model servise iletildi',
        jobId: jobId
      });
      
      // Socket.io ile istemciye bilgi gönder
      io.emit('processingUpdate', { 
        status: 'modelStarted', 
        message: 'Model işleme başladı, bu işlem birkaç dakika sürebilir...',
        jobId: jobId
      });
      
      // Durumu kontrol et (polling)
      let isComplete = false;
      const checkInterval = setInterval(async () => {
        try {
          const statusResponse = await axios.get(`${MODEL_SERVICE_URL}/api/status/${jobId}`);
          console.log(`Durum kontrolü: ${jobId}`, statusResponse.data);
          
          const status = statusResponse.data.status;
          
          if (status === 'completed') {
            clearInterval(checkInterval);
            isComplete = true;
            
            // İşlem tamamlandı bildirimi gönder
            io.emit('processingUpdate', { 
              status: 'completed', 
              message: 'İşlem tamamlandı!',
              jobId: jobId
            });
          } else if (status === 'error') {
            clearInterval(checkInterval);
            isComplete = true;
            
            // Hata bildirimi gönder
            io.emit('processingUpdate', { 
              status: 'error', 
              message: `Model hatası: ${statusResponse.data.error || 'Bilinmeyen hata'}`,
              jobId: jobId
            });
          }
        } catch (error) {
          console.error('Durum kontrolü hatası:', error.message);
        }
      }, 10000); // 10 saniyede bir kontrol et
      
    } catch (error) {
      console.error('Model servis hatası:', error.message);
      console.error('Hata detayları:', error.response ? error.response.data : 'Yanıt alınamadı');
      
      // Hata oluştuğunda kullanıcıya bildir
      io.emit('processingUpdate', { 
        status: 'error', 
        message: `Model servis hatası: ${error.message}`,
      });
      
      return res.status(500).json({
        status: 'error',
        error: `Model servisinde işlem başlatılamadı: ${error.message}`
      });
    }
    
  } catch (error) {
    console.error('Hata:', error);
    io.emit('processingUpdate', { status: 'error', message: 'İşlem sırasında hata: ' + error.message });
    res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
  }
});

app.get('/api/result/:jobId', async (req, res) => {
  const { jobId } = req.params;
  
  try {
    // Model servisinden sonuçları al
    const modelResponse = await axios.get(`${MODEL_SERVICE_URL}/api/result/${jobId}`);
    
    // Sonuçları doğrudan gönder
    res.status(200).json(modelResponse.data);
    
  } catch (error) {
    console.error('Sonuç alma hatası:', error.message);
    
    // Hata durumunu istemciye gönder
    if (error.response) {
      // Model servisinden gelen hata yanıtını ilet
      return res.status(error.response.status).json({
        status: 'error',
        error: `Model servisten hata: ${error.response.data.error || error.message}`
      });
    } else {
      // Bağlantı hatası durumu
      return res.status(500).json({
        status: 'error',
        error: `Model servise bağlanılamadı: ${error.message}`
      });
    }
  }
});

// AI Chat route
app.post('/api/ai-chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Mesaj içeriği gereklidir' });
    }

    // Use a publicly available Gemini API key for demo purposes
    // In production, this should be an environment variable
    const genAI = new GoogleGenerativeAI("AIzaSyAUr7jCxI7JUrCZH3JFRYRYAvicVgutdWQ");
    
    // For demonstration purposes, using a free tier model
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    // Format chat history for the API
    const formattedHistory = history.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    }));
    
    // Start a chat session
    const chat = model.startChat({
      history: formattedHistory,
      generationConfig: {
        maxOutputTokens: 1000,
      },
    });
    
    // Send the message to the model
    const result = await chat.sendMessage(message);
    const response = result.response;
    
    res.status(200).json({ 
      response: response.text(),
      model: 'gemini-1.0-pro'
    });
    
  } catch (error) {
    console.error('AI Chat Hatası:', error);
    res.status(500).json({ 
      error: 'AI servisine bağlanırken bir hata oluştu', 
      details: error.message 
    });
  }
});

// Yardımcı fonksiyonlar
function extractAudioFromVideo(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    console.log(`Video yolu: ${videoPath}`);
    console.log(`Ses yolu: ${audioPath}`);
    
    try {
      const command = ffmpeg(videoPath)
        .output(audioPath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioQuality(3);
        
      command.on('start', (commandLine) => {
        console.log('FFmpeg komutu başlatıldı:', commandLine);
      });
      
      command.on('progress', (progress) => {
        console.log('İşleme durumu:', progress.percent, '%');
      });
      
      command.on('end', () => {
        console.log('Ses ayıklama tamamlandı.');
        resolve();
      });
      
      command.on('error', (err) => {
        console.error('Ses ayıklama hatası:', err);
        reject(err);
      });
      
      console.log('FFmpeg komutu çalıştırılıyor...');
      command.run();
    } catch (err) {
      console.error('FFmpeg başlatma hatası:', err);
      reject(err);
    }
  });
}

// Sunucuyu başlat
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor`);
}); 