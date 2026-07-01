const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token yok' });
  try {
    const d = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = d.userId;
    next();
  } catch { res.status(401).json({ error: 'Gecersiz token' }); }
}

router.get('/', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM nfc_cards WHERE user_id=$1 ORDER BY created_at DESC', [req.userId]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Hata' }); }
});

router.post('/virtual', auth, async (req, res) => {
  try {
    const { label } = req.body;
    const card_uid = 'VIRTUAL-' + Math.random().toString(36).substr(2, 8).toUpperCase();
    const id = uuidv4();
    await pool.query(
      "INSERT INTO nfc_cards (id, user_id, card_uid, card_type, label, is_active) VALUES ($1,$2,$3,'virtual',$4,true)",
      [id, req.userId, card_uid, label || 'Sanal Kart']
    );
    res.json({ id, card_uid, label: label || 'Sanal Kart' });
  } catch (err) { res.status(500).json({ error: 'Hata' }); }
});

module.exports = router;
