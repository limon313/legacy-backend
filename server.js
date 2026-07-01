require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const pool = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/cards', require('./routes/cards'));
app.use('/api/qr', require('./routes/qr'));
app.use('/api/admin', require('./routes/admin'));

app.get('/health', (req, res) => res.json({ status: 'ok', app: 'Legacy' }));

app.listen(PORT, async () => {
  console.log('Legacy calisiyor: ' + PORT);
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(20) UNIQUE NOT NULL,
        email VARCHAR(100),
        password_hash TEXT NOT NULL,
        balance NUMERIC(12,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS nfc_cards (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        card_uid VARCHAR(50) UNIQUE NOT NULL,
        card_type VARCHAR(20) DEFAULT 'virtual',
        label VARCHAR(100),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        type VARCHAR(20) NOT NULL,
        amount NUMERIC(12,2) NOT NULL,
        description TEXT,
        status VARCHAR(20) DEFAULT 'success',
        reference_no VARCHAR(50),
        metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Tablolar hazir!');
  } catch(e) { console.error('Tablo hata:', e.message); }
});
