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

router.post('/topup', auth, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount) return res.status(400).json({ error: 'Tutar gerekli' });
    await pool.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [amount, req.userId]);
    const txId = uuidv4();
    await pool.query(
      "INSERT INTO transactions (id, user_id, type, amount, description, status, reference_no) VALUES ($1,$2,'topup',$3,'Bakiye Yukleme','success',$4)",
      [txId, req.userId, amount, 'TOP-' + Date.now()]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Hata' }); }
});

router.get('/balance', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT balance FROM users WHERE id=$1', [req.userId]);
    res.json({ balance: r.rows[0]?.balance || 0 });
  } catch (err) { res.status(500).json({ error: 'Hata' }); }
});

router.get('/history', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.userId]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Hata' }); }
});

// Kullanicidan kullaniciya transfer
router.post('/transfer', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { receiver_phone, amount, description } = req.body;
    if (!receiver_phone || !amount) return res.status(400).json({ error: 'Alici telefon ve tutar gerekli' });

    const senderRes = await client.query('SELECT * FROM users WHERE id=$1', [req.userId]);
    const sender = senderRes.rows[0];
    if (parseFloat(sender.balance) < parseFloat(amount)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Yetersiz bakiye' });
    }

    const receiverRes = await client.query('SELECT * FROM users WHERE phone=$1', [receiver_phone]);
    if (!receiverRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Alici bulunamadi' });
    }
    const receiver = receiverRes.rows[0];
    if (receiver.id === req.userId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Kendinize transfer yapamazsiniz' });
    }

    await client.query('UPDATE users SET balance=balance-$1 WHERE id=$2', [amount, sender.id]);
    await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [amount, receiver.id]);

    const refNo = 'TRF-' + Date.now();
    await client.query(
      "INSERT INTO transactions (id, user_id, type, amount, description, status, reference_no, metadata) VALUES ($1,$2,'transfer',$3,$4,'success',$5,$6)",
      [uuidv4(), sender.id, amount, description || receiver.name + "'e Transfer", refNo, JSON.stringify({ to: receiver.name, to_phone: receiver_phone })]
    );
    await client.query(
      "INSERT INTO transactions (id, user_id, type, amount, description, status, reference_no, metadata) VALUES ($1,$2,'topup',$3,$4,'success',$5,$6)",
      [uuidv4(), receiver.id, amount, sender.name + "'den Gelen Transfer", refNo, JSON.stringify({ from: sender.name })]
    );

    await client.query('COMMIT');
    res.json({ success: true, reference_no: refNo, receiver_name: receiver.name, new_balance: parseFloat(sender.balance) - parseFloat(amount) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Transfer hatasi' });
  } finally { client.release(); }
});

module.exports = router;
