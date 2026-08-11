const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Раздаем статические файлы из папки public
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`🔥 BATTLE ROYALE SERVER ONLINE`);
    console.log(`🌐 Port: ${PORT}`);
    console.log(`👥 Max Players: 50 | Tick: 30 Hz`);
    console.log(`=================================`);
});
