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

const qrStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of qrStore.entries()) {
    if (now > data.expiresAt) qrStore.delete(code);
  }
}, 60000);

router.post('/create', auth, async (req, res) => {
  try {
    const { amount, description } = req.body;
    if (!amount) return res.status(400).json({ error: 'Tutar gerekli' });
    const userRes = await pool.query('SELECT name FROM users WHERE id=$1', [req.userId]);
    const merchantName = userRes.rows[0]?.name || 'Satici';
    const qrCode = 'QR-' + uuidv4().slice(0, 8).toUpperCase();
    const expiresAt = Date.now() + 5 * 60 * 1000;
    qrStore.set(qrCode, { merchantId: req.userId, merchantName, amount: parseFloat(amount), description: description || 'Legacy Odeme', status: 'pending', expiresAt });
    res.json({ qr_code: qrCode, amount: parseFloat(amount), merchant_name: merchantName, expires_in_seconds: 300 });
  } catch (err) { res.status(500).json({ error: 'QR olusturulamadi' }); }
});

router.get('/status/:code', auth, async (req, res) => {
  const data = qrStore.get(req.params.code);
  if (!data) return res.status(404).json({ error: 'QR bulunamadi' });
  if (Date.now() > data.expiresAt) { qrStore.delete(req.params.code); return res.status(410).json({ error: 'QR suresi doldu' }); }
  res.json({ status: data.status, amount: data.amount, merchant_name: data.merchantName, description: data.description });
});

router.post('/pay/:code', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const data = qrStore.get(req.params.code);
    if (!data) return res.status(404).json({ error: 'QR bulunamadi' });
    if (Date.now() > data.expiresAt) { qrStore.delete(req.params.code); return res.status(410).json({ error: 'QR suresi doldu' }); }
    if (data.status === 'paid') return res.status(400).json({ error: 'Bu QR zaten odendi' });
    if (data.merchantId === req.userId) return res.status(400).json({ error: 'Kendi QR kodunuzu odeyemezsiniz' });

    await client.query('BEGIN');
    const buyerRes = await client.query('SELECT * FROM users WHERE id=$1', [req.userId]);
    const buyer = buyerRes.rows[0];
    if (parseFloat(buyer.balance) < data.amount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Yetersiz bakiye' }); }

    await client.query('UPDATE users SET balance=balance-$1 WHERE id=$2', [data.amount, req.userId]);
    await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [data.amount, data.merchantId]);

    const refNo = 'QR-TX-' + Date.now();
    await client.query("INSERT INTO transactions (id, user_id, type, amount, description, status, reference_no, metadata) VALUES ($1,$2,'payment',$3,$4,'success',$5,$6)",
      [uuidv4(), req.userId, data.amount, data.description, refNo, JSON.stringify({ qr_code: req.params.code, merchant: data.merchantName })]);
    await client.query("INSERT INTO transactions (id, user_id, type, amount, description, status, reference_no, metadata) VALUES ($1,$2,'topup',$3,$4,'success',$5,$6)",
      [uuidv4(), data.merchantId, data.amount, 'QR Tahsilat - ' + buyer.name, refNo, JSON.stringify({ qr_code: req.params.code, buyer: buyer.name })]);

    await client.query('COMMIT');
    data.status = 'paid';
    res.json({ success: true, reference_no: refNo, amount: data.amount, merchant_name: data.merchantName });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Odeme hatasi' });
  } finally { client.release(); }
});

module.exports = router;
