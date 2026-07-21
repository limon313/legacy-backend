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

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token yok' });
  try {
    const d = jwt.verify(token, process.env.JWT_SECRET);
    if (process.env.ADMIN_USER_ID && d.userId !== process.env.ADMIN_USER_ID) {
      return res.status(403).json({ error: 'Yetkiniz yok' });
    }
    req.userId = d.userId;
    next();
  } catch { res.status(401).json({ error: 'Gecersiz token' }); }
}

function detectBank(iban) {
  const clean = iban.replace(/\s/g, '').toUpperCase();
  const code = clean.substring(4, 9);
  const banks = {
    '00062': 'Garanti BBVA', '00010': 'Ziraat Bankasi', '00046': 'Akbank',
    '00067': 'Yapi Kredi', '00064': 'Is Bankasi', '00134': 'Denizbank',
    '00012': 'Halkbank', '00015': 'Vakifbank', '00111': 'QNB Finansbank',
    '00169': 'ING Bank', '00203': 'Papara', '00099': 'Enpara',
    '00092': 'Odeabank', '00123': 'HSBC', '00143': 'Fibabanka',
    '00205': 'Ininal', '00801': 'Ziraat Katilim', '00206': 'Turk Elektronik Para'
  };
  return banks[code] || 'Diger Banka';
}

function validIban(iban) {
  const clean = iban.replace(/\s/g, '').toUpperCase();
  return /^TR\d{24}$/.test(clean);
}

// Kullanici cekim talebi olusturur
router.post('/request', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { iban, receiver_name, amount, note } = req.body;
    if (!iban || !receiver_name || !amount) {
      return res.status(400).json({ error: 'IBAN, alici adi ve tutar zorunlu' });
    }
    if (!validIban(iban)) {
      return res.status(400).json({ error: 'Gecersiz IBAN (TR ile baslamali, 26 karakter)' });
    }
    if (parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Tutar 0dan buyuk olmali' });
    }

    await client.query('BEGIN');

    const userRes = await client.query('SELECT * FROM users WHERE id=$1', [req.userId]);
    const user = userRes.rows[0];
    if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Kullanici bulunamadi' }); }
    if (parseFloat(user.balance) < parseFloat(amount)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Yetersiz bakiye' });
    }

    // Bakiye hemen dusulur (dondurulur)
    await client.query('UPDATE users SET balance=balance-$1 WHERE id=$2', [amount, req.userId]);

    const cleanIban = iban.replace(/\s/g, '').toUpperCase();
    const bankName = detectBank(cleanIban);
    const refNo = 'WD-' + Date.now();
    const reqId = uuidv4();

    await client.query(
      `INSERT INTO withdrawal_requests (id, user_id, iban, bank_name, receiver_name, amount, note, status, reference_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
      [reqId, req.userId, cleanIban, bankName, receiver_name, amount, note || null, refNo]
    );

    await client.query(
      `INSERT INTO transactions (id, user_id, type, amount, description, status, reference_no, metadata)
       VALUES ($1,$2,'withdrawal',$3,$4,'pending',$5,$6)`,
      [uuidv4(), req.userId, amount, receiver_name + ' - ' + bankName, refNo,
       JSON.stringify({ iban: cleanIban, bank: bankName, request_id: reqId })]
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      request_id: reqId,
      reference_no: refNo,
      bank: bankName,
      amount: parseFloat(amount),
      status: 'pending',
      new_balance: parseFloat(user.balance) - parseFloat(amount)
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Talep olusturulamadi' });
  } finally { client.release(); }
});

// Kullanicinin kendi talepleri
router.get('/my-requests', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM withdrawal_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.userId]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Hata' }); }
});

// IBAN'dan banka tespiti
router.post('/detect-bank', auth, (req, res) => {
  const { iban } = req.body;
  if (!iban) return res.status(400).json({ error: 'IBAN gerekli' });
  res.json({ bank: detectBank(iban), valid: validIban(iban) });
});

// ADMIN: tum talepler
router.get('/admin/list', adminAuth, async (req, res) => {
  try {
    const status = req.query.status;
    let q = `SELECT w.*, u.name as user_name, u.phone as user_phone
             FROM withdrawal_requests w JOIN users u ON w.user_id = u.id`;
    const params = [];
    if (status) { q += ' WHERE w.status=$1'; params.push(status); }
    q += ' ORDER BY w.created_at DESC LIMIT 200';
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Hata' }); }
});

// ADMIN: talebi onayla (para gonderildi)
router.post('/admin/approve/:id', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wr = await client.query('SELECT * FROM withdrawal_requests WHERE id=$1', [req.params.id]);
    if (!wr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Talep bulunamadi' }); }
    const w = wr.rows[0];
    if (w.status !== 'pending') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Bu talep zaten islenmis' }); }

    await client.query(
      "UPDATE withdrawal_requests SET status='approved', processed_at=NOW(), admin_note=$1 WHERE id=$2",
      [req.body.admin_note || null, req.params.id]
    );
    await client.query(
      "UPDATE transactions SET status='success' WHERE reference_no=$1",
      [w.reference_no]
    );

    await client.query('COMMIT');
    res.json({ success: true, status: 'approved' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Hata' });
  } finally { client.release(); }
});

// ADMIN: talebi reddet (bakiye iade)
router.post('/admin/reject/:id', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wr = await client.query('SELECT * FROM withdrawal_requests WHERE id=$1', [req.params.id]);
    if (!wr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Talep bulunamadi' }); }
    const w = wr.rows[0];
    if (w.status !== 'pending') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Bu talep zaten islenmis' }); }

    // Bakiye iade
    await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [w.amount, w.user_id]);

    await client.query(
      "UPDATE withdrawal_requests SET status='rejected', processed_at=NOW(), admin_note=$1 WHERE id=$2",
      [req.body.admin_note || null, req.params.id]
    );
    await client.query(
      "UPDATE transactions SET status='rejected' WHERE reference_no=$1",
      [w.reference_no]
    );
    await client.query(
      `INSERT INTO transactions (id, user_id, type, amount, description, status, reference_no)
       VALUES ($1,$2,'topup',$3,'Cekim talebi iadesi','success',$4)`,
      [uuidv4(), w.user_id, w.amount, 'RFD-' + Date.now()]
    );

    await client.query('COMMIT');
    res.json({ success: true, status: 'rejected' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Hata' });
  } finally { client.release(); }
});

module.exports = router;
