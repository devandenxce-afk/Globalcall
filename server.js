const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

let waitingUsers = [];
const socketPhones = {};

function isCompatible(a, b) {
  const langOk = a.lang === 'any' || b.lang === 'any' || a.lang === b.lang;
  const countryOk = a.country === 'any' || b.country === 'any' || a.country === b.country;
  return langOk && countryOk;
}

function findMatch(newUser) {
  for (let i = 0; i < waitingUsers.length; i++) {
    if (isCompatible(newUser.prefs, waitingUsers[i].prefs)) return i;
  }
  if (newUser.prefs.lang === 'any' && newUser.prefs.country === 'any') {
    return waitingUsers.length > 0 ? 0 : -1;
  }
  return -1;
}

async function isBanned(phone) {
  if (!phone) return false;
  const { data } = await supabase
    .from('bans')
    .select('phone')
    .eq('phone', phone)
    .maybeSingle();
  return !!data;
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('register-phone', (phone) => {
    socketPhones[socket.id] = phone;
  });

  socket.on('start-match', async (prefs) => {
    const phone = socketPhones[socket.id];
    if (phone && await isBanned(phone)) {
      socket.emit('banned');
      return;
    }
    const userPrefs = {
      lang: prefs?.lang || 'any',
      country: prefs?.country || 'any'
    };
    const newUser = { id: socket.id, prefs: userPrefs, joinedAt: Date.now() };
    const matchIndex = findMatch(newUser);
    if (matchIndex !== -1) {
      const partner = waitingUsers.splice(matchIndex, 1)[0];
      socket.join(partner.id);
      io.to(partner.id).emit('match-found', { partnerId: socket.id, initiator: true });
      socket.emit('match-found', { partnerId: partner.id, initiator: false });
      console.log(`Matched: ${partner.id} <-> ${socket.id}`);
    } else {
      waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
      waitingUsers.push(newUser);
      socket.emit('waiting');
      console.log(`Waiting: ${socket.id} queue=${waitingUsers.length}`);
    }
  });

  socket.on('cancel-match', () => {
    waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
  });

  socket.on('report-user', async ({ reportedSocket, reason }) => {
    const reporterPhone = socketPhones[socket.id];
    const reportedPhone = socketPhones[reportedSocket];
    console.log(`Report: ${reporterPhone} -> ${reportedPhone || reportedSocket} (${reason})`);
    await supabase.from('reports').insert({
      reporter_phone: reporterPhone || 'unknown',
      reported_phone: reportedPhone || null,
      reported_socket: reportedSocket || null,
      reason: reason
    });
    if (reportedPhone) {
      const { data: userReports } = await supabase
        .from('reports')
        .select('id')
        .eq('reported_phone', reportedPhone);
      const count = userReports?.length || 0;
      console.log(`${reportedPhone} now has ${count} reports`);
      if (count >= 3) {
        await supabase.from('bans').insert({
          phone: reportedPhone,
          reason: `Auto-banned after ${count} reports`
        });
        console.log(`BANNED: ${reportedPhone}`);
        io.to(reportedSocket).emit('banned');
      }
    }
  });

  socket.on('offer', ({ to, offer }) => io.to(to).emit('offer', { from: socket.id, offer }));
  socket.on('answer', ({ to, answer }) => io.to(to).emit('answer', { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));
  socket.on('end-call', ({ to }) => { if (to) io.to(to).emit('partner-left'); });

  socket.on('disconnect', () => {
    waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
    delete socketPhones[socket.id];
    console.log('User disconnected:', socket.id);
  });
});

async function getMpesaToken() {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');
  const res = await axios.get(
    'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return res.data.access_token;
}

app.post('/api/mpesa/topup', async (req, res) => {
  const { phone, amount } = req.body;
  try {
    let cleanPhone = String(phone).replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '254' + cleanPhone.slice(1);
    if (!cleanPhone.startsWith('254') && cleanPhone.length === 9) {
      cleanPhone = '254' + cleanPhone;
    }
    const token = await getMpesaToken();
    const eat = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const timestamp = eat.toISOString().replace(/\D/g, '').slice(0, 14);
    const password = Buffer.from(
      `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
    ).toString('base64');
    const response = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: cleanPhone,
        PartyB: process.env.MPESA_SHORTCODE,
        PhoneNumber: cleanPhone,
        CallBackURL: 'https://globalcall-production-ee02.up.railway.app/api/mpesa/callback',
        AccountReference: cleanPhone,
        TransactionDesc: 'GlobalCall credits'
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log('STK Push sent:', response.data);
    res.json(response.data);
  } catch (error) {
    console.error('M-Pesa error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Payment failed' });
  }
});

app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const { Body } = req.body;
    const callback = Body?.stkCallback;
    if (!callback) return res.json({ ResultCode: 0, ResultDesc: 'No callback' });
    if (callback.ResultCode === 0) {
      const items = callback.CallbackMetadata.Item;
      const amount = items.find(i => i.Name === 'Amount')?.Value;
      const phone = String(items.find(i => i.Name === 'PhoneNumber')?.Value);
      const creditsSeconds = Math.floor(amount * (3600 / 130));
      console.log(`Payment: ${phone} paid ${amount} KES -> ${creditsSeconds} sec`);
      const { data: existing } = await supabase
        .from('users')
        .select('*')
        .eq('phone', phone)
        .maybeSingle();
      if (existing) {
        await supabase
          .from('users')
          .update({ balance_seconds: existing.balance_seconds + creditsSeconds })
          .eq('phone', phone);
      } else {
        await supabase.from('users').insert({ phone, balance_seconds: creditsSeconds });
      }
    }
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (err) {
    console.error('Callback error:', err);
    res.json({ ResultCode: 0, ResultDesc: 'Handled' });
  }
});

const FREE_SECONDS = 300;

app.get('/api/balance/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    if (await isBanned(phone)) {
      return res.json({ balance: 0, new_user: false, banned: true });
    }
    const { data } = await supabase
      .from('users')
      .select('balance_seconds')
      .eq('phone', phone)
      .maybeSingle();
    if (data) {
      res.json({ balance: data.balance_seconds, new_user: false, banned: false });
    } else {
      await supabase.from('users').insert({ phone, balance_seconds: FREE_SECONDS });
      console.log(`New user: ${phone} -> ${FREE_SECONDS} free seconds`);
      res.json({ balance: FREE_SECONDS, new_user: true, banned: false });
    }
  } catch (err) {
    console.error('Balance error:', err);
    res.status(500).json({ balance: 0, new_user: false, banned: false });
  }
});

app.post('/api/balance/deduct', async (req, res) => {
  try {
    const { phone, seconds } = req.body;
    const { data: user } = await supabase
      .from('users')
      .select('balance_seconds')
      .eq('phone', phone)
      .maybeSingle();
    if (user) {
      const newBalance = Math.max(0, user.balance_seconds - seconds);
      await supabase
        .from('users')
        .update({ balance_seconds: newBalance })
        .eq('phone', phone);
      res.json({ balance: newBalance });
    } else {
      res.json({ balance: 0 });
    }
  } catch (err) {
    res.status(500).json({ balance: 0 });
  }
});

// ===== APPEALS =====
app.post('/api/appeal', async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message || message.length < 10) {
      return res.status(400).json({ error: 'Invalid appeal' });
    }
    const { error } = await supabase.from('appeals').insert({
      phone: phone,
      message: message,
      status: 'pending'
    });
    if (error) throw error;
    console.log(`Appeal submitted: ${phone}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Appeal error:', err);
    res.status(500).json({ error: 'Failed to submit appeal' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
