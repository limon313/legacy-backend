const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token yok' });
  try {
    const d = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = d.userId;
    next();
  } catch { res.status(401).json({ error: 'Gecersiz token' }); }
}

router.post('/register', async (req, res) => {
  try {
    const { name, phone, email, password } = req.body;
    if (!name || !phone || !password) return res.status(400).json({ error: 'Eksik alan' });
    const hashed = await bcrypt.hash(password, 10);
    const id = uuidv4();
    const card_uid = 'VIRTUAL-' + Math.random().toString(36).substr(2, 8).toUpperCase();
    await pool.query(
      'INSERT INTO users (id, name, phone, email, password_hash, balance) VALUES ($1,$2,$3,$4,$5,0)',
      [id, name, phone, email || null, hashed]
    );
    await pool.query(
      "INSERT INTO nfc_cards (id, user_id, card_uid, card_type, is_active) VALUES ($1,$2,$3,'virtual',true)",
      [uuidv4(), id, card_uid]
    );
    const token = jwt.sign({ userId: id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, userId: id, card_uid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatasi' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE phone=$1', [phone]);
    if (!result.rows.length) return res.status(401).json({ error: 'Kullanici bulunamadi' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Sifre hatali' });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, userId: user.id, name: user.name, balance: user.balance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatasi' });
  }
});

router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name, phone, email, balance FROM users WHERE id=$1', [req.userId]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Hata' }); }
});

module.exports = router;
