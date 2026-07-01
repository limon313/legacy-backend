const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');

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

router.get('/summary', adminAuth, async (req, res) => {
  try {
    const usersCount = await pool.query('SELECT COUNT(*) FROM users');
    const totalBalance = await pool.query('SELECT COALESCE(SUM(balance),0) as total FROM users');
    const txCount = await pool.query('SELECT COUNT(*) FROM transactions');
    const txToday = await pool.query("SELECT COUNT(*) FROM transactions WHERE created_at >= CURRENT_DATE");
    const volumeByType = await pool.query('SELECT type, COUNT(*) as count, COALESCE(SUM(amount),0) as total FROM transactions GROUP BY type');
    res.json({
      total_users: parseInt(usersCount.rows[0].count),
      total_balance: parseFloat(totalBalance.rows[0].total),
      total_transactions: parseInt(txCount.rows[0].count),
      transactions_today: parseInt(txToday.rows[0].count),
      volume_by_type: volumeByType.rows
    });
  } catch (err) { res.status(500).json({ error: 'Hata' }); }
});

router.get('/users', adminAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name, phone, email, balance, created_at FROM users ORDER BY created_at DESC LIMIT 100');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Hata' }); }
});

router.get('/transactions', adminAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT t.*, u.name as user_name, u.phone as user_phone FROM transactions t JOIN users u ON t.user_id = u.id ORDER BY t.created_at DESC LIMIT 200');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Hata' }); }
});

router.post('/adjust-balance', adminAuth, async (req, res) => {
  try {
    const { user_id, amount, reason } = req.body;
    if (!user_id || amount === undefined) return res.status(400).json({ error: 'Eksik alan' });
    await pool.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [amount, user_id]);
    await pool.query(
      "INSERT INTO transactions (id, user_id, type, amount, description, status, reference_no) VALUES ($1,$2,'topup',$3,$4,'success',$5)",
      [uuidv4(), user_id, Math.abs(amount), reason || 'Admin duzeltme', 'ADM-' + Date.now()]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Hata' }); }
});

module.exports = router;
